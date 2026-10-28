#!/usr/bin/env node
// Long-lived NDJSON worker. No daemon access: the only output is local text/state.
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelManager } from './model.mjs';

const RATE = 16000;
export const MAX_SAMPLES = RATE * 300;
const fail = (code, message) => Object.assign(Error(message), { code });
const damagedModel = names => fail('model_damaged', `The voice model is damaged (${names.join(', ')}). Download it again in Settings → Voice.`);
export const RECORDER_COMMANDS = [
  ['pw-record', '--rate', '16000', '--channels', '1', '--format', 'f32', '-'],
  ['parec', '--raw', '--format=float32le', '--rate=16000', '--channels=1', '--latency-msec=40']
];

export async function record() {
  for (const [command, ...args] of RECORDER_COMMANDS) {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      return child;
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('recorder_error', error.message);
    }
  }
  throw fail('recorder_missing', 'Install pw-record (PipeWire) or parec (pulseaudio-utils) to record voice.');
}

export class Transcriber {
  constructor({ model = new ModelManager(), loadRuntime = () => import('sherpa-onnx-node'), record: recorder = record,
    emit = event => process.stdout.write(JSON.stringify(event) + '\n') } = {}) {
    Object.assign(this, { model, loadRuntime, record: recorder, emit });
    this.state = 'idle';
    this.generation = 0;
  }

  async recognizer() {
    const status = await this.model.status();
    if (status.state === 'damaged') throw damagedModel(status.damaged);
    if (status.state !== 'installed') throw fail('model_missing', 'Download the optional Parakeet model in Settings → Voice.');
    if (!this.runtime) {
      try { const mod = await this.loadRuntime(); this.runtime = mod.default || mod; }
      catch { throw fail('runtime_missing', 'Voice unavailable: run pnpm install in the plugin directory (sherpa-onnx-node 2.0.1).'); }
    }
    if (!this.engine) {
      const config = {
        featConfig: { sampleRate: RATE, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: join(status.path, 'encoder.int8.onnx'), decoder: join(status.path, 'decoder.int8.onnx'),
            joiner: join(status.path, 'joiner.int8.onnx')
          },
          tokens: join(status.path, 'tokens.txt'), modelType: 'nemo_transducer',
          numThreads: Math.min(4, availableParallelism()), provider: 'cpu', debug: 0
        },
        decodingMethod: 'greedy_search'
      };
      try {
        this.engine = this.runtime.OfflineRecognizer.createAsync
          ? await this.runtime.OfflineRecognizer.createAsync(config) : new this.runtime.OfflineRecognizer(config);
      } catch (error) {
        // sherpa-onnx only says it failed; hash the files once to tell a damaged model apart.
        const check = await this.model.check?.().catch(() => null);
        if (check?.damaged?.length) throw damagedModel(check.damaged);
        throw error;
      }
    }
    return this.engine;
  }

  async decode(samples, sampleRate, generation) {
    if (!samples.length) throw fail('empty_audio', 'No audio was recorded.');
    const stream = this.engine.createStream();
    stream.acceptWaveform({ sampleRate, samples: samples.subarray(0, sampleRate * 300) });
    this.emit({ type: 'transcribing' });
    if (this.engine.decodeAsync) await this.engine.decodeAsync(stream);
    else this.engine.decode(stream);
    if (generation !== this.generation) return;
    const text = String(this.engine.getResult(stream).text || '').trim();
    if (!text) throw fail('empty_audio', 'No speech was recognized.');
    this.emit({ type: 'transcript', text });
  }

  feed(bytes) {
    const chunk = Buffer.concat([this.pending, bytes]);
    const count = Math.min(Math.floor(chunk.length / 4), MAX_SAMPLES - this.count);
    let energy = 0;
    for (let i = 0; i < count; i++) {
      const value = chunk.readFloatLE(i * 4);
      const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      this.samples[this.count++] = sample;
      energy += sample * sample;
    }
    this.pending = chunk.subarray(Math.floor(chunk.length / 4) * 4);
    if (count) this.rms = Math.sqrt(energy / count);
    if (this.count === MAX_SAMPLES && this.state === 'recording') void this.handle({ cmd: 'stop' });
  }

  async endCapture() {
    clearInterval(this.meter);
    clearTimeout(this.limit);
    const child = this.child;
    this.child = null;
    if (child) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 1000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
  }

  async cancel(emit = true) {
    this.generation++;
    this.state = 'idle';
    await this.endCapture();
    this.samples = null;
    this.pending = Buffer.alloc(0);
    if (emit) this.emit({ type: 'cancelled' });
  }

  async handle(command) {
    try {
      if (!command || typeof command !== 'object' || Array.isArray(command)) throw fail('bad_command', 'Expected a JSON command object.');
      const { cmd } = command;
      if (cmd === 'cancel') { await this.cancel(); return; }
      if (cmd === 'stop') {
        if (this.state !== 'recording') throw fail('empty_audio', 'No recording is in progress.');
        this.state = 'transcribing';
        const generation = this.generation;
        await this.endCapture();
        if (generation !== this.generation) return;
        const samples = this.samples.subarray(0, this.count);
        this.samples = null;
        try { await this.decode(samples, RATE, generation); }
        finally { this.state = 'idle'; }
        return;
      }
      if (cmd !== 'start' && cmd !== 'transcribe_file') throw fail('bad_command', 'Commands: start, stop, cancel, transcribe_file (path).');
      if (this.state !== 'idle') throw fail('busy', 'Voice is already recording or transcribing.');
      this.state = 'loading';
      const generation = this.generation;
      try {
        await this.recognizer();
        if (generation !== this.generation) return;
        if (cmd === 'transcribe_file') {
          if (typeof command.path !== 'string' || !command.path) throw fail('bad_command', 'transcribe_file requires a WAV path.');
          const wave = this.runtime.readWave(command.path);
          if (!wave || !wave.samples || !wave.sampleRate) throw fail('invalid_audio', 'Cannot read this WAV file.');
          this.state = 'transcribing';
          await this.decode(wave.samples, wave.sampleRate, generation);
          return;
        }
        const child = await this.record();
        if (generation !== this.generation) { child.kill('SIGTERM'); return; }
        this.child = child;
        this.samples = new Float32Array(MAX_SAMPLES);
        this.count = 0;
        this.rms = 0;
        this.pending = Buffer.alloc(0);
        this.state = 'recording';
        child.stdout.on('data', bytes => { if (this.samples) this.feed(bytes); });
        child.once('close', () => {
          if (this.child !== child) return;
          this.child = null;
          void this.cancel(false);
          this.emit({ type: 'error', code: 'recorder_error', message: 'The recorder stopped unexpectedly. Check the audio device.' });
        });
        this.emit({ type: 'recording', seconds: 0 });
        this.meter = setInterval(() => {
          this.emit({ type: 'level', rms: this.rms });
          this.emit({ type: 'recording', seconds: this.count / RATE });
        }, 100);
        this.limit = setTimeout(() => { if (this.state === 'recording') void this.handle({ cmd: 'stop' }); }, 300000);
      } finally { if (this.state !== 'recording') this.state = 'idle'; }
    } catch (error) {
      this.emit({ type: 'error', code: error.code || 'transcriber_error', message: error.message });
    }
  }
}

// realpath: the shell runs the plugin through a symlinked directory, and import.meta.url is resolved.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node voice/transcriber.mjs\nNDJSON stdin: {cmd:"start"|"stop"|"cancel"} or {cmd:"transcribe_file",path:"/path/file.wav"}.\nNDJSON stdout: recording, level, transcribing, transcript, cancelled, error. No audio leaves this process.');
  } else {
    const worker = new Transcriber();
    let queue = Promise.resolve();
    const input = createInterface({ input: process.stdin });
    input.on('line', line => {
      let command;
      try { command = JSON.parse(line); }
      catch { command = null; }
      // Cancellation can invalidate an asynchronous model load/decode immediately.
      if (command?.cmd === 'cancel') worker.generation++;
      queue = queue.then(() => worker.handle(command));
    });
    input.on('close', () => { void queue.finally(() => worker.cancel(false)); });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      void worker.cancel(false).finally(() => process.exit(0));
    });
  }
}
