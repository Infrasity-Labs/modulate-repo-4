'use strict';

// Shared helpers for the relay tests: start a relay against mock Velma servers
// and talk to it like a browser would.

const http = require('node:http');
const { WebSocket } = require('ws');
const { loadConfig } = require('../src/config');
const { createRelay } = require('../src/relay');
const { startMockVelma } = require('./mock-velma');

const KEY = 'SECRET-KEY-for-tests-0001';

async function setup({ mock: mockOpts = {}, limits = {}, config: configPatch } = {}) {
  const mock = await startMockVelma({ apiKey: KEY, ...mockOpts });
  const config = loadConfig({ VELMA_API_KEY: KEY });
  config.upstream.sttUrl = mock.sttUrl;
  config.upstream.detectUrl = mock.detectUrl;
  Object.assign(config.limits, limits);
  if (configPatch) configPatch(config);

  const logs = [];
  const relay = createRelay(config, { logger: (line) => logs.push(line) });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    mock,
    relay,
    logs,
    port,
    async close() {
      await relay.close();
      await new Promise((r) => server.close(r));
      await mock.close();
    },
  };
}

function connect(port, { origin } = {}) {
  const headers = {};
  const o = origin === undefined ? `http://127.0.0.1:${port}` : origin;
  if (o) headers.Origin = o;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`, { headers });
  const client = { ws, raw: [], messages: [], closeInfo: null, error: null };
  ws.on('message', (data) => {
    const text = data.toString();
    client.raw.push(text);
    client.messages.push(JSON.parse(text));
  });
  ws.on('error', (err) => {
    client.error = err.message;
  });
  client.closed = new Promise((resolve) =>
    ws.on('close', (code, reason) => {
      client.closeInfo = { code, reason: reason.toString() };
      resolve(client.closeInfo);
    }),
  );
  client.opened = new Promise((resolve) => ws.on('open', resolve));
  client.waitFor = async (predicate, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = client.messages.find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting. Got: ${JSON.stringify(client.messages)}`);
  };
  client.relayMessage = (type, ms) =>
    client.waitFor((m) => m.source === 'relay' && m.type === type, ms);
  return client;
}

async function until(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

module.exports = { KEY, setup, connect, until };
