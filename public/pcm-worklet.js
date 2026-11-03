// Turns audio from the browser into 16 kHz mono signed 16-bit little-endian PCM
// (s16le) and posts it in chunks of about 100 ms.
//
// If the AudioContext runs at 16 kHz, samples pass straight through. If the
// browser could not give a 16 kHz context (the context rate is often 44.1 or
// 48 kHz), this processor downsamples by averaging the input samples that fall
// into each output sample. Averaging acts as a simple low-pass filter, which is
// enough for speech. Channels are mixed down to mono by averaging.
//
// Messages out:  ArrayBuffer of s16le samples, or the string "flushed".
// Messages in:   "flush" posts any partial chunk, then "flushed".

class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.chunkSamples = opts.chunkSamples || Math.round(this.targetRate / 10); // 100 ms
    this.ratio = sampleRate / this.targetRate; // input samples per output sample
    this.chunk = new Int16Array(this.chunkSamples);
    this.length = 0;
    this.sum = 0;
    this.count = 0;
    this.phase = 0;
    this.last = 0;

    this.port.onmessage = (event) => {
      if (event.data === 'flush') {
        this.postChunk(true);
        this.port.postMessage('flushed');
      }
    };
  }

  postChunk(partial) {
    if (this.length === 0) return;
    const samples = partial ? this.chunk.slice(0, this.length) : this.chunk;
    const buffer = samples.buffer;
    this.port.postMessage(buffer, [buffer]);
    this.chunk = new Int16Array(this.chunkSamples);
    this.length = 0;
  }

  pushSample(value) {
    const clamped = value > 1 ? 1 : value < -1 ? -1 : value;
    this.chunk[this.length++] = clamped < 0 ? clamped * 32768 : clamped * 32767;
    if (this.length === this.chunkSamples) this.postChunk(false);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    const channels = input.length;

    for (let i = 0; i < frames; i++) {
      let mono = 0;
      for (let c = 0; c < channels; c++) mono += input[c][i];
      mono /= channels;

      this.sum += mono;
      this.count += 1;
      this.phase += 1;
      while (this.phase >= this.ratio) {
        this.last = this.count > 0 ? this.sum / this.count : this.last;
        this.pushSample(this.last);
        this.sum = 0;
        this.count = 0;
        this.phase -= this.ratio;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
