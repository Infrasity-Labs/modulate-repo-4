'use strict';

// Two local WebSocket servers that speak the Velma streaming protocol:
// speech-to-text and synthetic voice detection. Used by the unit tests, the
// failure checks and the browser test so none of them spend credits.
// Message shapes follow the Velma docs.

const http = require('node:http');
const { WebSocketServer } = require('ws');

const BYTES_PER_SECOND = 32000; // s16le, 16 kHz, mono
const FRAME_BYTES = BYTES_PER_SECOND * 4; // one detection frame is 4 seconds

const WORDS = [
  'hello', 'this', 'is', 'a', 'test', 'of', 'the', 'live', 'transcript', 'and',
  'the', 'meeting', 'starts', 'at', 'three', 'in', 'the', 'afternoon',
];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey                Key the mock accepts.
 * @param {string[]} [opts.verdicts]          Verdicts cycled by the detection mock.
 * @param {{code:number,error:string}} [opts.rejectWith]  Send error and close with this code right after open.
 * @param {boolean} [opts.silent]             Never send results (idle and limit tests).
 */
async function startMockVelma(opts) {
  const verdicts = opts.verdicts || ['non-synthetic'];
  const state = {
    connections: [], // every connection ever made, with what it received
    active: { stt: 0, detect: 0 },
  };

  function makeServer(kind) {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://x');
      const conn = {
        kind,
        query: Object.fromEntries(url.searchParams),
        binaryBytes: 0,
        binaryFrames: 0,
        texts: [],
        closeCode: null,
        sentEnd: false,
      };
      state.connections.push(conn);
      state.active[kind] += 1;
      ws.on('close', (code) => {
        conn.closeCode = code;
        state.active[kind] -= 1;
      });

      const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

      if (conn.query.api_key !== opts.apiKey) {
        send({ type: 'error', error: 'Invalid API key.' });
        return ws.close(4001);
      }
      if (opts.rejectWith) {
        send({ type: 'error', error: opts.rejectWith.error });
        return ws.close(opts.rejectWith.code);
      }

      let bytes = 0;
      let utteranceIndex = 0;
      let wordCount = 0;
      let frameCount = 0;
      let lastFrameEnd = 0;

      function emitFrame(endBytes) {
        const startMs = Math.round((lastFrameEnd / BYTES_PER_SECOND) * 1000);
        const endMs = Math.round((endBytes / BYTES_PER_SECOND) * 1000);
        send({
          type: 'frame',
          frame: {
            start_time_ms: startMs,
            end_time_ms: endMs,
            verdict: verdicts[frameCount % verdicts.length],
            confidence: 0.9 + (frameCount % 10) / 100,
          },
        });
        frameCount += 1;
        lastFrameEnd = endBytes;
      }

      function emitUtterance() {
        if (wordCount === 0) return;
        const words = Array.from({ length: wordCount }, (_, i) => WORDS[(utteranceIndex * 5 + i) % WORDS.length]);
        send({
          type: 'utterance',
          utterance: {
            utterance_uuid: `mock-utt-${utteranceIndex}`,
            text: `${words.join(' ')}.`,
            start_ms: utteranceIndex * 3000,
            duration_ms: wordCount * 600,
            speaker: 1,
            language: 'en',
            emotion: null,
            accent: null,
            deepfake_score: null,
          },
        });
        utteranceIndex += 1;
        wordCount = 0;
      }

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          conn.binaryBytes += data.length;
          conn.binaryFrames += 1;
          if (opts.silent) return;
          const before = bytes;
          bytes += data.length;
          if (kind === 'detect') {
            while (bytes - lastFrameEnd >= FRAME_BYTES) emitFrame(lastFrameEnd + FRAME_BYTES);
          } else if (Math.floor(bytes / (BYTES_PER_SECOND / 2)) > Math.floor(before / (BYTES_PER_SECOND / 2))) {
            // A partial every half second, a final every 3 seconds.
            wordCount += 1;
            const words = Array.from({ length: wordCount }, (_, i) => WORDS[(utteranceIndex * 5 + i) % WORDS.length]);
            send({
              type: 'partial_utterance',
              partial_utterance: {
                utterance_uuid: `mock-utt-${utteranceIndex}`,
                text: words.join(' '),
                start_ms: utteranceIndex * 3000,
                speaker: 1,
                emotion: null,
                accent: null,
                deepfake_score: null,
              },
            });
            if (wordCount >= 6) emitUtterance();
          }
          return;
        }
        const text = data.toString();
        conn.texts.push(text);
        if (text !== '') return;
        conn.sentEnd = true;
        if (opts.silent) return;
        const durationMs = Math.round((bytes / BYTES_PER_SECOND) * 1000);
        if (kind === 'detect') {
          if (bytes > lastFrameEnd) emitFrame(bytes);
          send({ type: 'done', duration_ms: durationMs, frame_count: frameCount });
        } else {
          emitUtterance();
          send({ type: 'done', duration_ms: durationMs });
        }
        ws.close(1000);
      });
    });
    return { server, wss };
  }

  const stt = makeServer('stt');
  const detect = makeServer('detect');
  const sttPort = await listen(stt.server);
  const detectPort = await listen(detect.server);

  return {
    sttUrl: `ws://127.0.0.1:${sttPort}/api/velma-2-stt-streaming`,
    detectUrl: `ws://127.0.0.1:${detectPort}/api/velma-2-synthetic-voice-detection-streaming`,
    state,
    // Close every live connection of one kind the way Velma would on a limit.
    dropActive(kind, code, error) {
      const { wss } = kind === 'stt' ? stt : detect;
      for (const c of wss.clients) {
        c.send(JSON.stringify({ type: 'error', error }));
        c.close(code);
      }
    },
    async close() {
      for (const { server, wss } of [stt, detect]) {
        for (const c of wss.clients) c.terminate();
        await new Promise((r) => server.close(r));
      }
    },
  };
}

module.exports = { startMockVelma, BYTES_PER_SECOND };
