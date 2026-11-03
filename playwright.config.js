'use strict';

const path = require('node:path');
const { defineConfig } = require('@playwright/test');

// The fake microphone plays this file on a loop.
const FAKE_MIC = path.join(__dirname, 'fixtures', 'real-1.wav');

module.exports = defineConfig({
  testDir: 'test',
  testMatch: 'e2e.spec.js',
  timeout: 120000,
  workers: 1,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 860, height: 1000 },
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${FAKE_MIC}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
});
