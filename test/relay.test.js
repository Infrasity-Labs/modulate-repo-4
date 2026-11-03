'use strict';

const test = require('node:test');
const net = require('node:net');
const assert = require('node:assert/strict');
const { CLOSE_MESSAGES } = require('../src/relay');
const { BYTES_PER_SECOND } = require('./mock-velma');

const { KEY, setup, connect, until } = require('./helpers');

const oneSecond = () => Buffer.alloc(BYTES_PER_SECOND);

test('forwards audio to both upstreams and wraps messages with the source', async () => {
  const t = await setup({ mock: { verdicts: ['synthetic', 'non-synthetic'] } });
  try {
    const c = connect(t.port);
    await c.relayMessage('ready');
    for (let i = 0; i < 5; i++) c.ws.send(oneSecond());
    c.ws.send('');
    const info = await c.closed;
    assert.equal(info.code, 1000);

    const [stt, detect] = ['stt', 'detect'].map((k) => t.mock.state.connections.find((x) => x.kind === k));
    assert.equal(stt.binaryBytes, 5 * BYTES_PER_SECOND);
    assert.equal(detect.binaryBytes, 5 * BYTES_PER_SECOND);
    assert.deepEqual(stt.texts, ['']);
    assert.deepEqual(detect.texts, ['']);

    const bySource = (source, type) =>
      c.messages.filter((m) => m.source === source && m.message && m.message.type === type);
    assert.ok(bySource('stt', 'partial_utterance').length > 0);
    assert.ok(bySource('stt', 'utterance').length > 0);
    assert.equal(bySource('stt', 'done').length, 1);
    const frames = bySource('detect', 'frame');
    assert.equal(frames.length, 2);
    assert.equal(frames[0].message.frame.verdict, 'synthetic');
    assert.equal(frames[1].message.frame.verdict, 'non-synthetic');
    const detectDone = bySource('detect', 'done')[0].message;
    assert.equal(detectDone.frame_count, 2);
    assert.equal(detectDone.duration_ms, 5000);
  } finally {
    await t.close();
  }
});

test('opens upstreams with raw audio parameters and the key', async () => {
  const t = await setup();
  try {
    const c = connect(t.port);
    await c.relayMessage('ready');
    const [stt, detect] = ['stt', 'detect'].map((k) => t.mock.state.connections.find((x) => x.kind === k));
    for (const conn of [stt, detect]) {
      assert.equal(conn.query.api_key, KEY);
      assert.equal(conn.query.audio_format, 's16le');
      assert.equal(conn.query.sample_rate, '16000');
      assert.equal(conn.query.num_channels, '1');
    }
    assert.equal(stt.query.partial_results, 'true');
    assert.equal(stt.query.speaker_diarization, 'true');
    assert.equal(detect.query.partial_results, undefined);
    c.ws.close();
  } finally {
    await t.close();
  }
});

test('does not say ready until both upstreams are open', async () => {
  const t = await setup({ config: (cfg) => (cfg.upstream.detectUrl = 'ws://127.0.0.1:1/nothing-here') });
  try {
    const c = connect(t.port);
    const err = await c.relayMessage('error');
    assert.equal(err.code, 'unreachable');
    assert.ok(!c.messages.some((m) => m.type === 'ready'));
  } finally {
    await t.close();
  }
});

test('gives up when an upstream accepts the connection but never answers', async () => {
  const silent = net.createServer(() => {}); // accepts TCP, never completes the handshake
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const t = await setup({
    config: (cfg) => {
      cfg.upstream.detectUrl = `ws://127.0.0.1:${silent.address().port}/hang`;
      cfg.upstream.connectTimeoutMs = 300;
    },
  });
  try {
    const c = connect(t.port);
    const err = await c.relayMessage('error');
    assert.equal(err.code, 'unreachable');
    assert.ok(!c.messages.some((m) => m.type === 'ready'));
    assert.ok(await until(() => t.relay.activeSessions() === 0));
    assert.ok(await until(() => t.mock.state.active.stt === 0));
  } finally {
    await t.close();
    silent.close();
  }
});

test('queues a little audio sent before ready, then forwards it', async () => {
  const t = await setup();
  try {
    const c = connect(t.port);
    await c.opened;
    c.ws.send(Buffer.alloc(3200));
    c.ws.send(Buffer.alloc(3200));
    await c.relayMessage('ready');
    c.ws.send('');
    await c.closed;
    for (const k of ['stt', 'detect']) {
      assert.equal(t.mock.state.connections.find((x) => x.kind === k).binaryBytes, 6400);
    }
  } finally {
    await t.close();
  }
});

test('each Velma close code becomes one readable message', async () => {
  for (const code of Object.keys(CLOSE_MESSAGES).map(Number)) {
    const t = await setup({ mock: { rejectWith: { code, error: `upstream said ${code}` } } });
    try {
      const c = connect(t.port);
      const err = await c.relayMessage('error');
      assert.equal(err.message, CLOSE_MESSAGES[code], `code ${code}`);
      assert.equal(err.code, code);
      await c.closed;
    } finally {
      await t.close();
    }
  }
  assert.match(CLOSE_MESSAGES[4029], /out of credits/);
  assert.match(CLOSE_MESSAGES[4001], /API key/);
});

test('an unknown close code gets a generic connection lost message', async () => {
  const t = await setup({ mock: { rejectWith: { code: 4999, error: 'who knows' } } });
  try {
    const c = connect(t.port);
    const err = await c.relayMessage('error');
    assert.match(err.message, /connection to Velma was lost/);
  } finally {
    await t.close();
  }
});

test('the key never reaches the browser or the logs', async () => {
  // The upstream error text echoes the key. The relay must still not leak it.
  const t = await setup({
    mock: { rejectWith: { code: 4001, error: `bad key ${KEY} api_key=${KEY}` } },
  });
  const ok = await setup();
  try {
    const a = connect(t.port);
    await a.relayMessage('error');
    await a.closed;
    const b = connect(ok.port);
    await b.relayMessage('ready');
    b.ws.send(oneSecond());
    b.ws.send('');
    await b.closed;

    for (const c of [a, b]) {
      assert.ok(c.raw.length > 0);
      for (const text of c.raw) {
        assert.ok(!text.includes(KEY), 'key in browser message');
        assert.ok(!/api_key/i.test(text) || text.includes('api_key=***'), 'api_key in browser message');
        assert.ok(!text.includes('127.0.0.1'), 'upstream URL in browser message');
      }
      assert.ok(!(c.closeInfo.reason || '').includes(KEY));
    }
    const lines = [...t.logs, ...ok.logs];
    assert.ok(lines.length > 0);
    for (const line of lines) assert.ok(!line.includes(KEY), `key in log: ${line}`);
    assert.ok(lines.some((l) => l.includes('api_key=***')));
  } finally {
    await t.close();
    await ok.close();
  }
});

test('refuses a third session while two are active, and frees the slot afterwards', async () => {
  const t = await setup({ limits: { maxSessions: 2 } });
  try {
    const a = connect(t.port);
    const b = connect(t.port);
    await a.relayMessage('ready');
    await b.relayMessage('ready');
    const c = connect(t.port);
    const busy = await c.relayMessage('error');
    assert.equal(busy.code, 'busy');
    assert.match(busy.message, /busy/);
    await c.closed;
    assert.equal(t.relay.activeSessions(), 2);

    a.ws.close();
    assert.ok(await until(() => t.relay.activeSessions() === 1));
    const d = connect(t.port);
    await d.relayMessage('ready');
    b.ws.close();
    d.ws.close();
  } finally {
    await t.close();
  }
});

test('ends a session at the time limit', async () => {
  const t = await setup({ limits: { maxSessionSeconds: 1 } });
  try {
    const c = connect(t.port);
    await c.relayMessage('ready');
    const err = await c.relayMessage('error');
    assert.equal(err.code, 'time_limit');
    assert.match(err.message, /limited to 1 seconds/);
    await c.closed;
    assert.ok(await until(() => t.mock.state.active.stt === 0 && t.mock.state.active.detect === 0));
  } finally {
    await t.close();
  }
});

test('ends a session after the idle timeout', async () => {
  const t = await setup({ limits: { idleTimeoutSeconds: 1 } });
  try {
    const c = connect(t.port);
    await c.relayMessage('ready');
    const err = await c.relayMessage('error');
    assert.equal(err.code, 'idle');
  } finally {
    await t.close();
  }
});

test('audio keeps the idle timer from firing', async () => {
  const t = await setup({ limits: { idleTimeoutSeconds: 1 } });
  try {
    const c = connect(t.port);
    await c.relayMessage('ready');
    for (let i = 0; i < 6; i++) {
      c.ws.send(Buffer.alloc(3200));
      await new Promise((r) => setTimeout(r, 400));
    }
    assert.ok(!c.messages.some((m) => m.type === 'error'));
    c.ws.close();
  } finally {
    await t.close();
  }
});

test('stops a session that sends more audio than the time limit allows', async () => {
  const t = await setup({ limits: { maxSessionBytes: 10000 } });
  try {
    const c = connect(t.port);
    await c.relayMessage('ready');
    c.ws.send(Buffer.alloc(6000));
    c.ws.send(Buffer.alloc(6000));
    const err = await c.relayMessage('error');
    assert.equal(err.code, 'audio_limit');
  } finally {
    await t.close();
  }
});

test('closes a connection that sends an oversized message', async () => {
  const t = await setup({ limits: { maxMessageBytes: 1000 } });
  try {
    const c = connect(t.port);
    await c.relayMessage('ready');
    c.ws.send(Buffer.alloc(5000));
    const info = await c.closed;
    assert.equal(info.code, 1009);
    assert.ok(await until(() => t.relay.activeSessions() === 0));
  } finally {
    await t.close();
  }
});

test('never forwards text from the browser other than the end-of-audio frame', async () => {
  const t = await setup();
  try {
    const c = connect(t.port);
    await c.relayMessage('ready');
    c.ws.send(JSON.stringify({ deepfake_signal: true, custom_terms: ['x'] }));
    const err = await c.relayMessage('error');
    assert.equal(err.code, 'bad_message');
    for (const conn of t.mock.state.connections) assert.deepEqual(conn.texts, []);
  } finally {
    await t.close();
  }
});

test('refuses WebSocket upgrades from another origin or with no origin', async () => {
  const t = await setup();
  try {
    const other = connect(t.port, { origin: 'https://evil.example' });
    await other.closed;
    assert.match(other.error, /403/);

    const none = connect(t.port, { origin: null });
    await none.closed;
    assert.match(none.error, /403/);

    assert.equal(t.mock.state.connections.length, 0);
    assert.equal(t.relay.activeSessions(), 0);

    const same = connect(t.port);
    await same.relayMessage('ready');
    same.ws.close();
  } finally {
    await t.close();
  }
});

test('accepts an extra origin from the allow list', async () => {
  const t = await setup({ config: (cfg) => (cfg.allowedOrigins = ['https://demo.example.com']) });
  try {
    const c = connect(t.port, { origin: 'https://demo.example.com' });
    await c.relayMessage('ready');
    c.ws.close();
  } finally {
    await t.close();
  }
});

test('limits new sessions per IP per hour', async () => {
  const t = await setup({ limits: { maxNewSessionsPerHourPerIp: 2 } });
  try {
    for (let i = 0; i < 2; i++) {
      const c = connect(t.port);
      await c.relayMessage('ready');
      c.ws.close();
      await c.closed;
    }
    const third = connect(t.port);
    const err = await third.relayMessage('error');
    assert.equal(err.code, 'rate_limited');
  } finally {
    await t.close();
  }
});

test('closes both upstreams when the browser leaves mid-stream', async () => {
  const t = await setup();
  try {
    const c = connect(t.port);
    await c.relayMessage('ready');
    c.ws.send(oneSecond());
    assert.equal(t.mock.state.active.stt, 1);
    assert.equal(t.mock.state.active.detect, 1);
    c.ws.terminate();
    assert.ok(await until(() => t.mock.state.active.stt === 0 && t.mock.state.active.detect === 0));
    assert.equal(t.relay.activeSessions(), 0);
  } finally {
    await t.close();
  }
});

test('when one upstream fails, the browser and the other upstream are closed', async () => {
  const t = await setup({ mock: { silent: true } });
  try {
    const c = connect(t.port);
    await c.relayMessage('ready');
    assert.equal(t.mock.state.active.stt, 1);
    assert.equal(t.mock.state.active.detect, 1);

    t.mock.dropActive('stt', 4030, 'Concurrent request limit reached.');

    const err = await c.relayMessage('error');
    assert.equal(err.message, CLOSE_MESSAGES[4030]);
    // The upstream error is also passed through, wrapped with its source.
    assert.ok(c.messages.some((m) => m.source === 'stt' && m.message.type === 'error'));
    await c.closed;
    assert.ok(await until(() => t.mock.state.active.detect === 0));
    assert.equal(t.relay.activeSessions(), 0);
  } finally {
    await t.close();
  }
});

test('ends the session when Velma never sends done after end of audio', async () => {
  const t = await setup({ mock: { silent: true }, limits: { finishTimeoutSeconds: 1 } });
  try {
    const c = connect(t.port);
    await c.relayMessage('ready');
    c.ws.send(oneSecond());
    c.ws.send('');
    const err = await c.relayMessage('error');
    assert.equal(err.code, 'finish_timeout');
    assert.ok(await until(() => t.mock.state.active.stt === 0 && t.mock.state.active.detect === 0));
  } finally {
    await t.close();
  }
});
