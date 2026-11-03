'use strict';

// Browser test with a fake microphone.
//
// Default: the relay talks to local mock Velma servers, so no credits are used.
// Live:    E2E_LIVE=1 with VELMA_API_KEY set sends audio to the real Velma API.
//          Screenshots in docs/ should be taken in this mode.

require('dotenv').config();
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startMockVelma } = require('./mock-velma');

const LIVE = process.env.E2E_LIVE === '1' && !!process.env.VELMA_API_KEY;
const MOCK_KEY = 'mock-key-for-e2e-0000';
const ACTIVE_KEY = LIVE ? process.env.VELMA_API_KEY : MOCK_KEY;
// Screenshots go to docs/ only for live runs. Mock runs must not overwrite them.
const DOCS = LIVE
  ? path.join(__dirname, '..', 'docs')
  : path.join(__dirname, '..', 'test-results', 'screenshots');

let mock;
let server;
let baseURL;
let serverLog = '';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test.beforeAll(async () => {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  if (!LIVE) {
    mock = await startMockVelma({
      apiKey: MOCK_KEY,
      verdicts: ['non-synthetic', 'synthetic'],
    });
    env.VELMA_API_KEY = MOCK_KEY;
    env.VELMA_STT_URL = mock.sttUrl;
    env.VELMA_DETECT_URL = mock.detectUrl;
  }
  server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${serverLog}`)), 10000);
    const onData = (chunk) => {
      serverLog += chunk.toString();
      if (serverLog.includes('Server is running')) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
  });
  baseURL = `http://localhost:${port}`;
});

test.afterAll(async () => {
  if (server) server.kill('SIGTERM');
  if (mock) await mock.close();
});

// Collect everything the page sees so the key leak check can search it.
function captureTraffic(page) {
  const seen = [];
  page.on('console', (m) => seen.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => seen.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    seen.push(`request: ${r.method()} ${r.url()} ${JSON.stringify(r.headers())} ${r.postData() || ''}`);
  });
  page.on('response', async (r) => {
    seen.push(`response: ${r.status()} ${r.url()} ${JSON.stringify(r.headers())}`);
    const type = r.headers()['content-type'] || '';
    if (/text|javascript|json|html|css/.test(type)) {
      try {
        seen.push(`body: ${await r.text()}`);
      } catch {
        // body not available for redirects
      }
    }
  });
  page.on('websocket', (ws) => {
    seen.push(`websocket: ${ws.url()}`);
    ws.on('framereceived', (f) => seen.push(`ws in: ${Buffer.from(f.payload, 'utf8').toString('latin1')}`));
    ws.on('framesent', (f) => {
      const text = typeof f.payload === 'string' ? f.payload : Buffer.from(f.payload).toString('latin1');
      seen.push(`ws out: ${text}`);
    });
  });
  return seen;
}

test('fake microphone: transcript and strip update, Stop reaches Done, key never leaks', async ({ page }) => {
  const seen = captureTraffic(page);
  fs.mkdirSync(DOCS, { recursive: true });
  const app = page.locator('#app');

  await page.goto(baseURL);
  await expect(page.locator('#status')).toHaveText('Ready');
  await app.screenshot({ path: path.join(DOCS, '01-ready.png') });

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('#status')).toHaveText('Listening', { timeout: 15000 });

  // Transcript text appears.
  const firstText = page.locator('.utterance__text').first();
  await expect(firstText).toHaveText(/\S+/, { timeout: 30000 });

  // At least one 4 second strip block appears.
  await expect(page.locator('#strip .frame').first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#summary')).toContainText('flagged synthetic');
  // Give the transcript time to show a partial line next to the first results.
  await page.locator('.utterance.is-partial').first().waitFor({ timeout: 15000 }).catch(() => {});
  await app.screenshot({ path: path.join(DOCS, '02-listening.png') });

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('#status')).toHaveText('Finishing');
  await expect(page.locator('#status')).toHaveText('Done', { timeout: 30000 });
  await expect(page.locator('#error')).toBeHidden();
  await app.screenshot({ path: path.join(DOCS, '03-done.png') });

  // Final text replaced any partial text.
  await expect(page.locator('.utterance.is-partial')).toHaveCount(0);

  // Key leak check: network traffic, console output and page source.
  seen.push(`page source: ${await page.content()}`);
  const secrets = [ACTIVE_KEY, process.env.VELMA_API_KEY].filter(Boolean);
  const everything = seen.join('\n');
  for (const secret of secrets) {
    expect(everything.includes(secret), 'API key found in browser-visible data').toBe(false);
  }
  expect(/api_key/i.test(everything), 'api_key parameter found in browser-visible data').toBe(false);
  expect(seen.some((line) => line.startsWith('ws in:'))).toBe(true);
  expect(seen.some((line) => line.startsWith('ws out:'))).toBe(true);
});

test('sample clip plays through the same pipeline', async ({ page }) => {
  await page.goto(baseURL);
  await page.locator('#sample-select').selectOption('synthetic-1.wav');
  await page.getByRole('button', { name: 'Play a sample clip' }).click();
  await expect(page.locator('#status')).toHaveText('Listening', { timeout: 15000 });
  await expect(page.locator('.utterance__text').first()).toHaveText(/\S+/, { timeout: 30000 });
  // The clip ends by itself, so the session finishes without a click.
  await expect(page.locator('#status')).toHaveText('Done', { timeout: 60000 });
  await expect(page.locator('#strip .frame').first()).toBeVisible();
});

for (const [name, message] of [
  ['NotAllowedError', /Microphone access was blocked/],
  ['NotFoundError', /No microphone was found/],
]) {
  test(`shows a plain message and Try again when the microphone fails with ${name}`, async ({ page }) => {
    await page.addInitScript((errorName) => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('x', errorName));
    }, name);
    await page.goto(baseURL);
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.locator('#status')).toHaveText('Error');
    await expect(page.locator('#error-text')).toHaveText(message);
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
}

test('page does not overflow at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(baseURL);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('downsamples in the worklet when the browser cannot run a 16 kHz audio context', async ({ page }) => {
  // Make the 16 kHz request fail, so the page falls back to the default rate.
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    window.__contextRates = [];
    window.AudioContext = function (options) {
      if (options && options.sampleRate) throw new DOMException('not supported', 'NotSupportedError');
      const ctx = new Native(options);
      window.__contextRates.push(ctx.sampleRate);
      return ctx;
    };
  });
  const sizes = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string') sizes.push(f.payload.length);
    }),
  );

  await page.goto(baseURL);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('#status')).toHaveText('Listening', { timeout: 15000 });
  const t0 = Date.now();
  await page.waitForTimeout(4000);
  const seconds = (Date.now() - t0) / 1000;
  const before = sizes.reduce((a, b) => a + b, 0);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('#status')).toHaveText('Done', { timeout: 30000 });

  const rates = await page.evaluate(() => window.__contextRates);
  expect(rates.length).toBe(1);
  expect(rates[0]).not.toBe(16000); // the fallback context ran at the device rate

  // About 3200 bytes per 100 ms chunk, and about 32000 bytes per second overall.
  const full = sizes.filter((n) => n === 3200).length;
  expect(full).toBeGreaterThan(sizes.length * 0.9);
  expect(before / seconds).toBeGreaterThan(32000 * 0.8);
  expect(before / seconds).toBeLessThan(32000 * 1.5);
});

test('screenshots of a synthetic and a human sample clip, desktop and phone', async ({ page }) => {
  fs.mkdirSync(DOCS, { recursive: true });
  const app = page.locator('#app');
  await page.goto(baseURL);

  for (const [clip, shot] of [
    ['synthetic-1.wav', '04-sample-synthetic.png'],
    ['real-1.wav', '05-sample-human.png'],
  ]) {
    await page.locator('#sample-select').selectOption(clip);
    await page.getByRole('button', { name: 'Play a sample clip' }).click();
    await expect(page.locator('#status')).toHaveText('Listening', { timeout: 15000 });
    await expect(page.locator('#status')).toHaveText('Done', { timeout: 60000 });
    await app.screenshot({ path: path.join(DOCS, shot) });
  }
});
