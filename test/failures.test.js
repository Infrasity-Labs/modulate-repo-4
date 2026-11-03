'use strict';

// Failure checks from the build brief.
//   1. Wrong key against the real Velma API: shows the readable 4001 message.
//   2. A third simultaneous session: shows the busy message.
//   3. A 130 second session: shows the time limit message at 120 seconds.
// Checks 2 and 3 use mock Velma servers and the default relay limits, so they
// spend no credits. With FAILURE_LIVE=1 they run against the real Velma API. Check 1 sends a made-up key to the real API.

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { loadConfig } = require('../src/config');
const { createRelay, CLOSE_MESSAGES } = require('../src/relay');
const { setup: setupMock, connect } = require('./helpers');
const { BYTES_PER_SECOND } = require('./mock-velma');

// Velma's reply time to a bad key varies from about 1 to 35 seconds, so wait longer.
// Same shape as the mock setup, but the relay talks to the real Velma API.
async function setupLive() {
  const relay = createRelay(loadConfig(process.env), { logger: () => {} });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    relay,
    port: server.address().port,
    async close() {
      await relay.close();
      await new Promise((r) => server.close(r));
    },
  };
}
const setup = process.env.FAILURE_LIVE === '1' ? setupLive : setupMock;

test('wrong key against the real Velma API shows a readable 4001 message', { timeout: 90000 }, async () => {
  const config = loadConfig({ VELMA_API_KEY: 'not-a-real-key-for-testing' });
  config.upstream.connectTimeoutMs = 60000;
  const logs = [];
  const relay = createRelay(config, { logger: (l) => logs.push(l) });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const c = connect(port);
    const err = await c.relayMessage('error', 60000);
    assert.equal(err.code, 4001);
    assert.equal(err.message, CLOSE_MESSAGES[4001]);
    // Velma sent its own error first. It is passed through, wrapped.
    assert.ok(c.messages.some((m) => ['stt', 'detect'].includes(m.source) && m.message.type === 'error'));
    await c.closed;
    for (const line of logs) assert.ok(!line.includes('not-a-real-key-for-testing'));
    console.log('real Velma replied:', JSON.stringify(c.messages.find((m) => m.source === 'stt' || m.source === 'detect')));
  } finally {
    await relay.close();
    await new Promise((r) => server.close(r));
  }
});

test('a third simultaneous session gets the busy message', async () => {
  const t = await setup(); // default limit: 2 sessions
  try {
    const a = connect(t.port);
    const b = connect(t.port);
    await a.relayMessage('ready');
    await b.relayMessage('ready');
    const c = connect(t.port);
    const err = await c.relayMessage('error');
    assert.equal(err.code, 'busy');
    console.log('busy message:', err.message);
    a.ws.close();
    b.ws.close();
  } finally {
    await t.close();
  }
});

test('a 130 second session is stopped at the 120 second limit', { timeout: 200000 }, async () => {
  const t = await setup(); // default limits: 120 seconds, 15 second idle timeout
  try {
    const started = Date.now();
    const c = connect(t.port);
    await c.relayMessage('ready');
    const chunk = Buffer.alloc(BYTES_PER_SECOND / 10); // 100 ms of audio
    const sender = setInterval(() => {
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(chunk);
    }, 100);
    const err = await c.waitFor((m) => m.source === 'relay' && m.type === 'error', 135000);
    clearInterval(sender);
    const elapsed = (Date.now() - started) / 1000;
    assert.equal(err.code, 'time_limit');
    assert.match(err.message, /limited to 120 seconds/);
    assert.ok(elapsed >= 119 && elapsed < 125, `stopped after ${elapsed}s`);
    console.log(`time limit message after ${elapsed.toFixed(1)}s:`, err.message);
    await c.closed;
  } finally {
    await t.close();
  }
});
