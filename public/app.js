// Browser client. Captures audio, sends 16 kHz s16le chunks to the relay at
// /stream, and shows the transcript and the authenticity strip.
// No framework and no build step.

(() => {
  'use strict';

  const TARGET_RATE = 16000;
  const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz
  const FINISH_WAIT_MS = 15000; // how long to wait for both done messages
  const FLUSH_WAIT_MS = 500;

  const $ = (id) => document.getElementById(id);
  const el = {
    toggle: $('toggle'),
    status: $('status'),
    timer: $('timer'),
    sampleSelect: $('sample-select'),
    sampleButton: $('sample-button'),
    error: $('error'),
    errorText: $('error-text'),
    retry: $('retry'),
    transcript: $('transcript'),
    transcriptEmpty: $('transcript-empty'),
    jump: $('jump'),
    summary: $('summary'),
    strip: $('strip'),
    frameList: $('frame-list'),
    meterFill: $('meter-fill'),
  };

  const STATUS_TEXT = {
    idle: 'Ready',
    connecting: 'Connecting',
    listening: 'Listening',
    finishing: 'Finishing',
    done: 'Done',
    error: 'Error',
  };

  let phase = 'idle';
  let session = null;
  let last = { kind: 'mic', clip: null };
  let counter = 0;

  const frames = [];
  const utterances = new Map(); // utterance_uuid -> element

  // ---------- status, timer, buttons ----------

  function setPhase(next) {
    phase = next;
    el.status.textContent = STATUS_TEXT[next];
    el.status.dataset.state = next;
    const running = next === 'connecting' || next === 'listening' || next === 'finishing';
    el.toggle.textContent = running ? 'Stop' : 'Start';
    el.toggle.disabled = next === 'finishing';
    el.sampleButton.disabled = running;
    el.sampleSelect.disabled = running;
  }

  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function startTimer(s) {
    s.startedAt = Date.now();
    const tick = () => {
      const elapsed = (Date.now() - s.startedAt) / 1000;
      el.timer.textContent = s.maxSeconds
        ? `${formatTime(elapsed)} of ${formatTime(s.maxSeconds)}`
        : formatTime(elapsed);
      if (s.maxSeconds) el.meterFill.style.width = `${Math.min(100, (elapsed / s.maxSeconds) * 100)}%`;
    };
    tick();
    s.timerId = setInterval(tick, 250);
  }

  function showError(message) {
    el.errorText.textContent = /[.!?]$/.test(message) ? message : `${message}.`;
    el.error.hidden = false;
  }

  function hideError() {
    el.error.hidden = true;
    el.errorText.textContent = '';
  }

  // ---------- transcript ----------

  let stickToBottom = true;

  el.transcript.addEventListener('scroll', () => {
    const gap = el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight;
    stickToBottom = gap < 24;
    el.jump.hidden = stickToBottom || utterances.size === 0;
  });

  el.jump.addEventListener('click', () => {
    stickToBottom = true;
    el.transcript.scrollTop = el.transcript.scrollHeight;
    el.jump.hidden = true;
    el.transcript.focus();
  });

  function scrollIfFollowing() {
    if (stickToBottom) el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function createUtteranceElement(startMs) {
    const p = document.createElement('p');
    p.className = 'utterance';
    p.dataset.start = startMs == null ? '' : String(startMs);
    const speaker = document.createElement('span');
    speaker.className = 'utterance__speaker';
    const text = document.createElement('span');
    text.className = 'utterance__text';
    p.append(speaker, text);

    // Keep utterances in time order when start times are known.
    let before = null;
    if (startMs != null) {
      for (const child of el.transcript.querySelectorAll('.utterance')) {
        const other = child.dataset.start === '' ? null : Number(child.dataset.start);
        if (other != null && other > startMs) {
          before = child;
          break;
        }
      }
    }
    el.transcript.insertBefore(p, before);
    return p;
  }

  function renderUtterance(u, isFinal) {
    if (!u || !u.utterance_uuid) return;
    let p = utterances.get(u.utterance_uuid);
    const text = (u.text || '').trim();

    if (!text) {
      if (p && isFinal) {
        p.remove();
        utterances.delete(u.utterance_uuid);
      }
      return;
    }
    if (!p) {
      el.transcriptEmpty.hidden = true;
      p = createUtteranceElement(u.start_ms);
      utterances.set(u.utterance_uuid, p);
    } else if (u.start_ms != null) {
      p.dataset.start = String(u.start_ms);
    }
    p.classList.toggle('is-partial', !isFinal);
    p.querySelector('.utterance__speaker').textContent =
      u.speaker == null ? 'Speaker' : `Speaker ${u.speaker}`;
    p.querySelector('.utterance__text').textContent = text;
    scrollIfFollowing();
  }

  // ---------- authenticity strip ----------

  function describeFrame(f) {
    const seconds = (ms) => Math.round(ms / 100) / 10; // one decimal place
    const from = seconds(f.start_time_ms);
    const to = seconds(f.end_time_ms);
    const pct = Math.round(f.confidence * 100);
    return {
      range: `${from} to ${to} s`,
      full: `${from} to ${to} s: ${f.verdict}, ${pct}% confidence`,
    };
  }

  function renderFrame(f) {
    if (!f || !['synthetic', 'non-synthetic', 'no-content'].includes(f.verdict)) return;
    frames.push(f);
    const d = describeFrame(f);

    const li = document.createElement('li');
    li.className = `frame frame--${f.verdict}`;
    li.tabIndex = 0;
    li.title = d.full;
    li.setAttribute('aria-label', d.full);
    const verdict = document.createElement('span');
    verdict.className = 'frame__verdict';
    verdict.textContent = f.verdict;
    const time = document.createElement('span');
    time.className = 'frame__time';
    time.textContent = d.range;
    li.append(verdict, time);
    el.strip.append(li);

    const row = document.createElement('li');
    row.textContent = d.full;
    el.frameList.append(row);

    updateSummary();
  }

  function updateSummary() {
    const silent = frames.filter((f) => f.verdict === 'no-content').length;
    const analysed = frames.length - silent;
    const synthetic = frames.filter((f) => f.verdict === 'synthetic').length;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (frames.length === 0) {
      el.summary.textContent = 'Waiting for the first result';
    } else if (analysed === 0) {
      el.summary.textContent = `No speech found yet in ${plural(silent, 'frame')}`;
    } else {
      let text = `${synthetic} of ${plural(analysed, 'frame')} flagged synthetic`;
      if (silent > 0) text += `, ${plural(silent, 'silent frame')} not counted`;
      el.summary.textContent = text;
    }
  }

  function resetResults() {
    for (const p of utterances.values()) p.remove();
    utterances.clear();
    el.transcriptEmpty.hidden = false;
    el.jump.hidden = true;
    stickToBottom = true;
    frames.length = 0;
    el.strip.replaceChildren();
    el.frameList.replaceChildren();
    el.timer.textContent = '0:00';
    el.meterFill.style.width = '0';
    updateSummary();
  }

  // ---------- audio ----------

  function mediaMessage(err) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return 'This page cannot use the microphone. Open it on https or on localhost';
    }
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Microphone access was blocked. Allow it in your browser settings, then try again';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No microphone was found. Connect one, or play a sample clip instead';
      case 'NotReadableError':
        return 'The microphone is busy in another app. Close that app and try again';
      default:
        return 'The microphone could not be started';
    }
  }

  async function buildGraph(s, rate) {
    // Ask for a 16 kHz context first. If the browser cannot do that, use its
    // default rate and let the worklet downsample.
    const ctx = rate ? new AudioContext({ sampleRate: rate }) : new AudioContext();
    s.ctx = ctx;
    await ctx.resume();
    await ctx.audioWorklet.addModule('pcm-worklet.js');

    const node = new AudioWorkletNode(ctx, 'pcm-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: TARGET_RATE, chunkSamples: CHUNK_SAMPLES },
    });
    s.node = node;
    node.port.onmessage = (event) => {
      if (event.data === 'flushed') {
        if (s.flushResolve) s.flushResolve();
      } else if (!s.ended && s.ws && s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(event.data);
      }
    };

    // The worklet only runs while connected to the destination. Mute it so the
    // microphone is never played back.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);

    if (s.kind === 'mic') {
      s.source = ctx.createMediaStreamSource(s.stream);
      s.source.connect(node);
    } else {
      const response = await fetch(`/fixtures/${encodeURIComponent(s.clip)}`);
      if (!response.ok) throw new Error('clip not found');
      // decodeAudioData resamples to the context rate.
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(node);
      source.connect(ctx.destination); // let people hear the clip
      source.onended = () => {
        if (session === s && phase === 'listening') stop();
      };
      s.source = source;
      s.startSource = () => source.start();
    }
  }

  // Disconnect and close the audio graph. Leaves the microphone stream alone.
  function teardownGraph(s) {
    try {
      if (s.source) {
        if (s.source.onended) s.source.onended = null;
        s.source.disconnect();
      }
      if (s.node) s.node.disconnect();
    } catch {
      // already disconnected
    }
    s.source = null;
    s.node = null;
    if (s.ctx) s.ctx.close().catch(() => {});
    s.ctx = null;
  }

  function teardownAudio(s) {
    if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
    s.stream = null;
    teardownGraph(s);
  }

  async function startAudio(s) {
    try {
      await buildGraph(s, TARGET_RATE);
    } catch (err) {
      // Some browsers refuse to connect a microphone to a 16 kHz context.
      console.debug('16 kHz context failed, using the default rate', err && err.name);
      teardownGraph(s);
      await buildGraph(s, undefined);
    }
    if (s.startSource) s.startSource();
  }

  // ---------- session ----------

  function endSession(s) {
    clearInterval(s.timerId);
    clearTimeout(s.finishTimer);
    teardownAudio(s);
    if (s.ws && s.ws.readyState <= WebSocket.OPEN) s.ws.close(1000);
    if (session === s) session = null;
  }

  function fail(s, message) {
    if (session !== s || s.failed) return;
    s.failed = true;
    endSession(s);
    setPhase('error');
    showError(message);
  }

  function succeed(s) {
    if (session !== s) return;
    s.finished = true;
    endSession(s);
    setPhase('done');
  }

  function onReady(s, msg) {
    s.maxSeconds = msg.maxSeconds || null;
    startAudio(s)
      .then(() => {
        if (session !== s || phase !== 'connecting') return;
        setPhase('listening');
        startTimer(s);
      })
      .catch((err) => {
        console.debug('audio start failed', err && err.name);
        fail(s, 'Audio could not be started in this browser. Try a recent Chrome, Edge, Firefox or Safari');
      });
  }

  function onMessage(s, event) {
    if (session !== s || typeof event.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.source === 'relay') {
      if (msg.type === 'ready') onReady(s, msg);
      else if (msg.type === 'error') fail(s, msg.message || 'Something went wrong');
      return;
    }

    const inner = msg.message || {};
    if (msg.source === 'stt') {
      if (inner.type === 'partial_utterance') renderUtterance(inner.partial_utterance, false);
      else if (inner.type === 'utterance') renderUtterance(inner.utterance, true);
      else if (inner.type === 'done') s.done.stt = true;
    } else if (msg.source === 'detect') {
      if (inner.type === 'frame') renderFrame(inner.frame);
      else if (inner.type === 'done') s.done.detect = true;
    }
    // Upstream errors are followed by one readable relay error, shown there.

    if (phase === 'finishing' && s.done.stt && s.done.detect) succeed(s);
  }

  async function start(kind, clip) {
    if (phase === 'connecting' || phase === 'listening' || phase === 'finishing') return;
    last = { kind, clip };
    resetResults();
    hideError();

    const s = {
      id: ++counter,
      kind,
      clip,
      ws: null,
      ctx: null,
      node: null,
      source: null,
      stream: null,
      done: { stt: false, detect: false },
      ended: false,
      failed: false,
      finished: false,
      maxSeconds: null,
      timerId: null,
      finishTimer: null,
    };
    session = s;
    setPhase('connecting');

    if (kind === 'mic') {
      try {
        s.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        });
      } catch (err) {
        return fail(s, mediaMessage(err));
      }
      if (session !== s) {
        s.stream.getTracks().forEach((t) => t.stop());
        return;
      }
    }

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/stream`);
    ws.binaryType = 'arraybuffer';
    s.ws = ws;
    ws.onmessage = (event) => onMessage(s, event);
    ws.onclose = () => {
      if (session !== s || s.finished) return;
      fail(s, 'The connection dropped. Check your network and try again');
    };
  }

  async function stop() {
    const s = session;
    if (!s) return;
    if (phase === 'connecting') {
      // Cancel before audio started.
      endSession(s);
      setPhase('idle');
      return;
    }
    if (phase !== 'listening') return;

    setPhase('finishing');
    clearInterval(s.timerId);

    // Stop capture, push out the last partial chunk, then end the audio.
    if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
    try {
      if (s.source) {
        s.source.onended = null;
        s.source.disconnect();
      }
    } catch {
      // ignore
    }
    if (s.node) {
      await new Promise((resolve) => {
        s.flushResolve = resolve;
        s.node.port.postMessage('flush');
        setTimeout(resolve, FLUSH_WAIT_MS);
      });
    }
    if (session !== s) return;

    s.ended = true;
    if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send('');
    s.finishTimer = setTimeout(
      () => fail(s, 'Velma did not confirm the end of the stream, so the results may be incomplete'),
      FINISH_WAIT_MS,
    );
    if (s.done.stt && s.done.detect) succeed(s);
  }

  // ---------- wiring ----------

  el.toggle.addEventListener('click', () => {
    if (phase === 'connecting' || phase === 'listening') stop();
    else start('mic', null);
  });

  el.sampleButton.addEventListener('click', () => start('sample', el.sampleSelect.value));

  el.retry.addEventListener('click', () => {
    if (phase === 'error' || phase === 'idle' || phase === 'done') start(last.kind, last.clip);
  });

  setPhase('idle');
  updateSummary();
})();
