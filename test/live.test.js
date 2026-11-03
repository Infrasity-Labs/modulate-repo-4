'use strict';

// Live test. Streams each fixture through the real relay to the real Velma API.
// Skipped when VELMA_API_KEY is not set. It spends a small amount of credit.

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocket } = require('ws');
const { loadConfig } = require('../src/config');
const { createRelay } = require('../src/relay');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const CLIPS = ['synthetic-1.wav', 'synthetic-2.wav', 'real-1.wav', 'real-2.wav'];
const CHUNK_BYTES = 3200; // 100 ms of s16le at 16 kHz

// Return the raw PCM from a 16-bit mono WAV file by walking its chunks.
function readPcm(file) {
  const buf = fs.readFileSync(file);
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'data') return buf.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}

async function streamClip(port, pcm) {
  const result = { utterances: [], partials: 0, frames: [], done: {}, relay: [], closeCode: null };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`, {
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  let ready;
  const readyPromise = new Promise((resolve) => (ready = resolve));

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.source === 'relay') {
      result.relay.push(msg);
      if (msg.type === 'ready') ready();
      if (msg.type === 'error') ready();
      return;
    }
    const inner = msg.message;
    if (inner.type === 'utterance') result.utterances.push(inner.utterance);
    if (inner.type === 'partial_utterance') result.partials += 1;
    if (inner.type === 'frame') result.frames.push(inner.frame);
    if (inner.type === 'done') result.done[msg.source] = inner;
  });

  await readyPromise;
  if (!result.relay.some((m) => m.type === 'error')) {
    for (let i = 0; i < pcm.length && ws.readyState === WebSocket.OPEN; i += CHUNK_BYTES) {
      ws.send(pcm.subarray(i, i + CHUNK_BYTES));
      await new Promise((r) => setTimeout(r, 100));
    }
    if (ws.readyState === WebSocket.OPEN) ws.send('');
  }
  let timer;
  result.closeCode = await Promise.race([
    closed,
    new Promise((r) => (timer = setTimeout(() => r('timeout'), 45000))),
  ]);
  clearTimeout(timer);
  ws.terminate();
  return result;
}

test('live: fixtures stream through the relay to Velma', { skip: !process.env.VELMA_API_KEY && 'VELMA_API_KEY is not set', timeout: 400000 }, async (t) => {
  const config = loadConfig(process.env);
  const lines = [];
  const relay = createRelay(config, { logger: (l) => lines.push(l) });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const summary = {};
  try {
    for (const clip of CLIPS) {
      await t.test(clip, async () => {
        const r = await streamClip(port, readPcm(path.join(FIXTURES, clip)));
        const verdicts = {};
        for (const f of r.frames) verdicts[f.verdict] = (verdicts[f.verdict] || 0) + 1;
        summary[clip] = {
          closeCode: r.closeCode,
          relayErrors: r.relay.filter((m) => m.type === 'error').map((m) => m.message),
          utteranceCount: r.utterances.length,
          partialCount: r.partials,
          transcript: r.utterances.map((u) => u.text).join(' '),
          verdicts,
          frames: r.frames,
          done: r.done,
        };
        assert.deepEqual(summary[clip].relayErrors, [], 'relay reported an error');
        assert.ok(r.utterances.length > 0, 'no utterance messages');
        assert.ok(r.frames.length > 0, 'no frame messages');
        assert.ok(r.done.stt, 'no done from stt');
        assert.ok(r.done.detect, 'no done from detect');
        assert.equal(r.closeCode, 1000);
      });
    }
  } finally {
    fs.mkdirSync(path.join(__dirname, '..', 'test-results'), { recursive: true });
    fs.writeFileSync(
      path.join(__dirname, '..', 'test-results', 'live-summary.json'),
      JSON.stringify(summary, null, 2),
    );
    for (const [clip, s] of Object.entries(summary)) {
      console.log(`${clip}: ${JSON.stringify(s.verdicts)} utterances=${s.utteranceCount}`);
    }
    // The key must not appear in the relay log, even in a live run.
    for (const line of lines) assert.ok(!line.includes(process.env.VELMA_API_KEY));
    await relay.close();
    await new Promise((r) => server.close(r));
  }
});
