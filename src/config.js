'use strict';

// All settings live here. Every value can be overridden from the environment
// or by passing options to createRelay().

const VELMA_HOST = 'wss://platform.modulate.ai/api';

// Audio the browser sends: signed 16-bit little-endian PCM, 16 kHz, mono.
const AUDIO = Object.freeze({
  format: 's16le',
  sampleRate: 16000,
  channels: 1,
  bytesPerSecond: 16000 * 2,
});

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function loadConfig(env = process.env) {
  const maxSessionSeconds = int(env.MAX_SESSION_SECONDS, 120);
  return {
    port: int(env.PORT, 8000),
    apiKey: env.VELMA_API_KEY || '',

    upstream: {
      // Override these only for tests against a mock server.
      sttUrl: env.VELMA_STT_URL || `${VELMA_HOST}/velma-2-stt-streaming`,
      detectUrl:
        env.VELMA_DETECT_URL ||
        `${VELMA_HOST}/velma-2-synthetic-voice-detection-streaming`,
      sttParams: {
        audio_format: AUDIO.format,
        sample_rate: AUDIO.sampleRate,
        num_channels: AUDIO.channels,
        speaker_diarization: true,
        partial_results: bool(env.PARTIAL_RESULTS, true),
      },
      detectParams: {
        audio_format: AUDIO.format,
        sample_rate: AUDIO.sampleRate,
        num_channels: AUDIO.channels,
      },
      // How long to wait for each Velma socket to open.
      connectTimeoutMs: int(env.CONNECT_TIMEOUT_SECONDS, 10) * 1000,
    },

    limits: {
      // Velma allows 3 connections per model by default. Two browser
      // sessions use two connections per model, so this app alone never
      // reaches the cap.
      maxSessions: int(env.MAX_SESSIONS, 2),
      maxSessionSeconds,
      idleTimeoutSeconds: int(env.IDLE_TIMEOUT_SECONDS, 15),
      // After the browser sends end-of-audio, wait this long for both done messages.
      finishTimeoutSeconds: int(env.FINISH_TIMEOUT_SECONDS, 30),
      maxNewSessionsPerHourPerIp: int(env.MAX_SESSIONS_PER_HOUR_PER_IP, 100),
      // Largest single message accepted from the browser.
      maxMessageBytes: int(env.MAX_MESSAGE_BYTES, 64 * 1024),
      // Total audio accepted per session. Real time plus 25 percent slack, so a
      // client cannot push more audio than the time limit allows.
      maxSessionBytes: Math.ceil(maxSessionSeconds * AUDIO.bytesPerSecond * 1.25),
      // Bytes held while the upstream sockets are still opening.
      maxQueuedBytes: int(env.MAX_QUEUED_BYTES, 256 * 1024),
    },

    // Extra allowed Origin values, comma separated, for example
    // "https://demo.example.com". The page's own origin is always allowed.
    allowedOrigins: (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    // Set to true behind one trusted reverse proxy (Render, Railway, Fly).
    // The client IP is then the last entry of X-Forwarded-For.
    trustProxy: bool(env.TRUST_PROXY, false),
  };
}

module.exports = { loadConfig, AUDIO };
