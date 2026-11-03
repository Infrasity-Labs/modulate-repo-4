'use strict';

// Relay between one browser WebSocket and two Velma WebSockets.
//
//   browser  <--->  relay  <--->  Velma speech-to-text streaming
//                          <--->  Velma synthetic voice detection streaming
//
// The API key is added to the upstream URLs here and never leaves this file's
// process. Messages sent to the browser:
//
//   { "source": "stt" | "detect", "message": <original Velma JSON> }
//   { "source": "relay", "type": "ready", "maxSeconds": 120 }
//   { "source": "relay", "type": "error", "code": "...", "message": "..." }

const { randomUUID } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

// Readable text for each Velma close code. Codes come from the Velma docs.
const CLOSE_MESSAGES = Object.freeze({
  1003: 'Velma rejected the audio settings sent by this demo',
  1011: 'Velma had a server error. Try again shortly',
  1013: 'Velma is temporarily at capacity. Try again shortly',
  4001: 'The Velma API key on the server is missing or not valid',
  4002: 'Velma could not decode the audio',
  4003: 'Velma did not permit this request',
  4004: 'The Velma API key does not have access to this model',
  4029: 'The Velma account is out of credits',
  4030: 'Velma is at its limit for simultaneous connections. Try again shortly',
  4031: 'The Velma account has reached its monthly usage limit',
});

const UNREACHABLE_MESSAGE = 'Could not connect to Velma. Try again shortly';
const LOST_MESSAGE = 'The connection to Velma was lost. Try again shortly';

function describeClose(code) {
  return CLOSE_MESSAGES[code] || LOST_MESSAGE;
}

// Replace the key and any api_key=... value in a string.
function scrubText(text, apiKey) {
  let out = String(text);
  if (apiKey) out = out.split(apiKey).join('***');
  return out.replace(/api_key=[^&\s"']*/gi, 'api_key=***');
}

function buildUpstreamUrl(base, params, apiKey) {
  const url = new URL(base);
  url.searchParams.set('api_key', apiKey);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, String(value));
  }
  return url.toString();
}

// True when the Origin header matches the Host the browser connected to, or an
// extra allowed origin.
function isAllowedOrigin(req, allowedOrigins = []) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function clientIp(req, trustProxy) {
  let ip = req.socket.remoteAddress || 'unknown';
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (forwarded.length) ip = forwarded[forwarded.length - 1];
  }
  return ip.replace(/^::ffff:/, '');
}

/**
 * @param {object} config  Result of loadConfig() from ./config.js
 * @param {object} [options]
 * @param {(line: string) => void} [options.logger]  Receives scrubbed log lines.
 */
function createRelay(config, options = {}) {
  const { apiKey, upstream, limits } = config;
  if (!apiKey) throw new Error('VELMA_API_KEY is not set');

  const writeLog = options.logger || ((line) => console.log(line));
  const log = (event, fields = {}) => {
    writeLog(scrubText(`[relay] ${event} ${JSON.stringify(fields)}`, apiKey));
  };

  const sttUrl = buildUpstreamUrl(upstream.sttUrl, upstream.sttParams, apiKey);
  const detectUrl = buildUpstreamUrl(upstream.detectUrl, upstream.detectParams, apiKey);

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxMessageBytes,
  });
  const sessions = new Map();
  const ipHits = new Map(); // ip -> timestamps of accepted sessions

  function allowNewSession(ip) {
    const now = Date.now();
    const cutoff = now - 3600 * 1000;
    if (ipHits.size > 1000) {
      for (const [key, times] of ipHits) {
        if (times[times.length - 1] < cutoff) ipHits.delete(key);
      }
    }
    const recent = (ipHits.get(ip) || []).filter((t) => t > cutoff);
    if (recent.length >= limits.maxNewSessionsPerHourPerIp) {
      ipHits.set(ip, recent);
      return false;
    }
    recent.push(now);
    ipHits.set(ip, recent);
    return true;
  }

  function sendToBrowser(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function rejectBrowser(ws, code, message, closeCode, ip) {
    log('rejected', { code, ip });
    sendToBrowser(ws, { source: 'relay', type: 'error', code, message });
    ws.close(closeCode, code);
  }

  function onConnection(ws, req) {
    const ip = clientIp(req, config.trustProxy);

    if (sessions.size >= limits.maxSessions) {
      return rejectBrowser(
        ws,
        'busy',
        'The demo is busy right now. Try again shortly',
        1013,
        ip,
      );
    }
    if (!allowNewSession(ip)) {
      return rejectBrowser(
        ws,
        'rate_limited',
        'Too many demo sessions from your network. Try again later',
        1008,
        ip,
      );
    }

    const id = randomUUID().slice(0, 8);
    const s = {
      id,
      ws,
      up: { stt: null, detect: null },
      open: { stt: false, detect: false },
      done: { stt: false, detect: false },
      upClosed: { stt: false, detect: false },
      ready: false,
      endRequested: false,
      closed: false,
      queue: [],
      queuedBytes: 0,
      audioBytes: 0,
      timers: {},
      startedAt: Date.now(),
    };
    sessions.set(id, s);
    log('session_start', { id, ip, active: sessions.size });

    // Tear down everything. Safe to call more than once.
    function cleanup(reason) {
      if (s.closed) return;
      s.closed = true;
      for (const t of Object.values(s.timers)) clearTimeout(t);
      sessions.delete(id);
      for (const name of ['stt', 'detect']) {
        const up = s.up[name];
        if (up && up.readyState !== WebSocket.CLOSED) up.terminate();
      }
      log('session_end', {
        id,
        reason,
        seconds: Math.round((Date.now() - s.startedAt) / 1000),
        audioBytes: s.audioBytes,
        active: sessions.size,
      });
    }

    // Tell the browser why, then close everything.
    function fail(code, message, closeCode = 1011, detail = {}) {
      if (s.closed) return;
      log('session_fail', { id, code, ...detail });
      sendToBrowser(ws, { source: 'relay', type: 'error', code, message });
      if (ws.readyState === WebSocket.OPEN) ws.close(closeCode, String(code).slice(0, 100));
      cleanup(code);
    }

    function forwardToUpstreams(data, binary) {
      for (const name of ['stt', 'detect']) {
        const up = s.up[name];
        if (up.readyState === WebSocket.OPEN) up.send(data, { binary });
      }
    }

    function requestEnd() {
      s.endRequested = true;
      clearTimeout(s.timers.idle);
      forwardToUpstreams('', false);
      s.timers.finish = setTimeout(
        () =>
          fail('finish_timeout', 'Velma did not finish in time. The results shown are partial', 1011),
        limits.finishTimeoutSeconds * 1000,
      );
    }

    function armIdle() {
      clearTimeout(s.timers.idle);
      s.timers.idle = setTimeout(
        () =>
          fail(
            'idle',
            `No audio arrived for ${limits.idleTimeoutSeconds} seconds, so the session was closed`,
            1008,
          ),
        limits.idleTimeoutSeconds * 1000,
      );
    }

    function onBothOpen() {
      if (s.closed || s.ready) return;
      s.ready = true;
      sendToBrowser(ws, {
        source: 'relay',
        type: 'ready',
        maxSeconds: limits.maxSessionSeconds,
      });
      armIdle();
      const queued = s.queue;
      s.queue = [];
      s.queuedBytes = 0;
      for (const item of queued) {
        if (item.end) requestEnd();
        else forwardToUpstreams(item.data, true);
      }
    }

    function maybeFinish() {
      if (s.upClosed.stt && s.upClosed.detect && !s.closed) {
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'done');
        cleanup('complete');
      }
    }

    function connectUpstream(name, url) {
      const up = new WebSocket(url, {
        handshakeTimeout: upstream.connectTimeoutMs,
        maxPayload: 4 * 1024 * 1024,
      });
      s.up[name] = up;

      // The ws handshakeTimeout does not cover a slow connect, so time it here.
      s.timers[`connect_${name}`] = setTimeout(
        () => fail('unreachable', UNREACHABLE_MESSAGE, 1011, { upstream: name, reason: 'connect_timeout' }),
        upstream.connectTimeoutMs,
      );

      up.on('open', () => {
        clearTimeout(s.timers[`connect_${name}`]);
        s.open[name] = true;
        if (s.open.stt && s.open.detect) onBothOpen();
      });

      up.on('message', (data, isBinary) => {
        if (s.closed || isBinary) return;
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message && message.type === 'done') s.done[name] = true;
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(scrubText(JSON.stringify({ source: name, message }), apiKey));
      });

      up.on('close', (code) => {
        if (s.closed) return;
        s.upClosed[name] = true;
        if (code === 1000) return maybeFinish();
        fail(code, describeClose(code), 1011, { upstream: name });
      });

      up.on('error', (err) => {
        // ws also emits close after an error, but fail() runs only once.
        log('upstream_error', { id, upstream: name, error: err.message });
        fail('unreachable', UNREACHABLE_MESSAGE, 1011, { upstream: name });
      });
    }

    ws.on('message', (data, isBinary) => {
      if (s.closed) return;
      if (s.ready && !s.endRequested) armIdle();

      if (isBinary) {
        if (s.endRequested) return;
        s.audioBytes += data.length;
        if (s.audioBytes > limits.maxSessionBytes) {
          return fail('audio_limit', 'Too much audio was sent for one session', 1008);
        }
        if (!s.ready) {
          s.queuedBytes += data.length;
          if (s.queuedBytes > limits.maxQueuedBytes) {
            return fail('queue_full', 'Audio was sent before the session was ready', 1008);
          }
          s.queue.push({ data });
          return;
        }
        return forwardToUpstreams(data, true);
      }

      // Only the empty text frame (end of audio) is allowed. Anything else could
      // reconfigure the upstream session, so it is refused.
      if (data.length !== 0) {
        return fail('bad_message', 'The browser sent an unexpected message', 1003);
      }
      if (s.endRequested) return;
      if (!s.ready) {
        s.endRequested = true;
        s.queue.push({ end: true });
        return;
      }
      requestEnd();
    });

    ws.on('close', () => cleanup('browser_closed'));
    ws.on('error', (err) => {
      log('browser_error', { id, error: err.message });
      cleanup('browser_error');
    });

    s.timers.max = setTimeout(
      () =>
        fail(
          'time_limit',
          `This demo is limited to ${limits.maxSessionSeconds} seconds per session. Start again to keep going`,
          1008,
        ),
      limits.maxSessionSeconds * 1000,
    );

    log('upstream_connect', { id, stt: scrubText(sttUrl), detect: scrubText(detectUrl) });
    connectUpstream('stt', sttUrl);
    connectUpstream('detect', detectUrl);
  }

  wss.on('connection', onConnection);

  return {
    // Call from the http server 'upgrade' event for the /stream path.
    handleUpgrade(req, socket, head) {
      if (!isAllowedOrigin(req, config.allowedOrigins)) {
        log('origin_refused', { origin: String(req.headers.origin || '') });
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    activeSessions: () => sessions.size,
    close() {
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

module.exports = {
  createRelay,
  describeClose,
  isAllowedOrigin,
  scrubText,
  CLOSE_MESSAGES,
};
