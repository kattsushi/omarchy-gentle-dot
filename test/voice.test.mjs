import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { ModelManager, SPEC } from '../voice/model.mjs';
import { Transcriber } from '../voice/transcriber.mjs';
import { loadRuntime } from '../voice/runtime.mjs';
import { SCALE } from './composer-harness.test.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(process.env.VOICE_TEST_ROOT || tmpdir(), 'voice-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const FAKE = Object.freeze({ 'encoder.int8.onnx': 'encoder', 'decoder.int8.onnx': 'decoder', 'joiner.int8.onnx': 'joiner', 'tokens.txt': 'tokens' });
const sha = text => createHash('sha256').update(text).digest('hex');
const pin = contents => Object.entries(contents).map(([name, text]) => ({ name, size: Buffer.byteLength(text), sha256: sha(text) }));
const fakeSpec = (extra = {}) => ({ ...SPEC, files: pin(FAKE), ...extra });

// A tarball of `contents`, with a spec that pins `pinned` (default: the same files).
async function archive(t, { omit, contents = FAKE, pinned = FAKE } = {}) {
  const dir = await scratch(t);
  const root = join(dir, SPEC.archiveRoot);
  await mkdir(root);
  for (const [name, text] of Object.entries(contents)) if (name !== omit) await writeFile(join(root, name), text);
  const bytes = execFileSync('tar', ['-cjf', '-', '-C', dir, SPEC.archiveRoot]);
  return { bytes, spec: { ...SPEC, files: pin(pinned), size: bytes.length, sha256: sha(bytes) } };
}

// An installed fake model: FAKE with `overrides` written over it.
async function installed(t, overrides = {}) {
  const root = await scratch(t);
  const spec = fakeSpec();
  await mkdir(join(root, spec.dir));
  for (const [name, text] of Object.entries({ ...FAKE, ...overrides })) await writeFile(join(root, spec.dir, name), text);
  return new ModelManager({ root, spec, fetcher: async () => { throw Error('no network in tests'); } });
}

test('the shipped spec pins size and SHA-256 for every model file', () => {
  assert.deepEqual(SPEC.files.map(f => f.name), ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']);
  for (const file of SPEC.files) {
    assert.ok(Number.isInteger(file.size) && file.size > 0, file.name);
    assert.match(file.sha256, /^[0-9a-f]{64}$/, file.name);
  }
  assert.equal(SPEC.files[0].sha256, 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247');
});

for (const failure of [null, 'checksum', 'size', 'joiner.int8.onnx', 'file hash']) {
  test(`model atomic install/status/remove: ${failure || 'success'}`, async t => {
    const root = await scratch(t);
    const { bytes, spec } = await archive(t, failure === 'joiner.int8.onnx' ? { omit: failure }
      // Same size, different content: only the per-file SHA-256 can tell.
      : failure === 'file hash' ? { contents: { ...FAKE, 'encoder.int8.onnx': 'encodeX' } } : {});
    if (failure === 'checksum') spec.sha256 = '0'.repeat(64);
    if (failure === 'size') spec.size++;
    const events = [];
    const manager = new ModelManager({ root, spec, fetcher: async () => new Response(bytes) });
    assert.equal((await manager.status()).state, 'missing');
    if (failure) {
      await assert.rejects(manager.download(e => events.push(e)), failure === 'file hash' ? /checksum.*encoder\.int8\.onnx/ : Error);
      assert.equal((await manager.status()).state, 'missing');
      assert.deepEqual(await readdir(root), []);
    } else {
      await manager.download(e => events.push(e));
      assert.equal((await manager.status()).state, 'installed');
      assert.equal((await manager.check()).state, 'installed');
      assert.equal(events[0].type, 'progress');
      assert.equal(events[0].received, 0);
      assert.ok(events.some(e => e.received === spec.size && e.total === spec.size));
      assert.deepEqual(await readdir(root), [SPEC.dir]);
      await manager.remove();
      assert.equal((await manager.status()).state, 'missing');
      assert.deepEqual(await readdir(root), []);
    }
  });
}

test('status flags a size mismatch as damaged without hashing', async t => {
  const manager = await installed(t, { 'decoder.int8.onnx': 'decoder, but longer' });
  const status = await manager.status();
  assert.deepEqual({ state: status.state, missing: status.missing, damaged: status.damaged },
    { state: 'damaged', missing: [], damaged: ['decoder.int8.onnx'] });
  assert.deepEqual((await manager.check()).damaged, ['decoder.int8.onnx']);
});

test('deep check finds a same-size content change that status cannot see', async t => {
  const manager = await installed(t, { 'encoder.int8.onnx': 'encodeX' });
  assert.equal((await manager.status()).state, 'installed');
  const check = await manager.check();
  assert.deepEqual({ type: check.type, state: check.state, path: check.path, missing: check.missing, damaged: check.damaged },
    { type: 'model', state: 'damaged', path: manager.path, missing: [], damaged: ['encoder.int8.onnx'] });
  const intact = await installed(t);
  assert.deepEqual((await intact.check()).damaged, []);
  assert.equal((await intact.check()).state, 'installed');
});

test('redownload replaces a damaged model; a plain download leaves it alone', async t => {
  const root = await scratch(t);
  const { bytes, spec } = await archive(t);
  const manager = new ModelManager({ root, spec, fetcher: async () => new Response(bytes) });
  await mkdir(manager.path);
  for (const [name, text] of Object.entries({ ...FAKE, 'encoder.int8.onnx': 'encodeX' })) await writeFile(join(manager.path, name), text);
  assert.equal((await manager.check()).state, 'damaged');
  // Same size: status cannot see it, so a plain download is a no-op.
  assert.equal((await manager.download()).state, 'installed');
  await writeFile(join(manager.path, 'joiner.int8.onnx'), 'joiner, but longer');
  await assert.rejects(manager.download(), /damaged.*redownload/);
  await assert.rejects(manager.redownload(() => {}, AbortSignal.abort(Error('cancelled'))));
  assert.equal((await manager.check()).state, 'missing');
  await mkdir(manager.path);
  for (const [name, text] of Object.entries({ ...FAKE, 'encoder.int8.onnx': 'encodeX' })) await writeFile(join(manager.path, name), text);
  const result = await manager.redownload(() => {});
  assert.equal(result.state, 'installed');
  assert.equal((await manager.check()).state, 'installed');
  assert.deepEqual(await readdir(root), [SPEC.dir]);
});

test('cancel cleans staging and concurrent operations are refused', async t => {
  const root = await scratch(t);
  const controller = new AbortController();
  const manager = new ModelManager({ root, fetcher: async (_url, { signal }) => {
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const download = manager.download(() => {}, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(manager.remove(), /busy/);
  await assert.rejects(manager.download(), /busy/);
  controller.abort();
  await assert.rejects(download);
  assert.deepEqual(await readdir(root), []);
});

test('worker protocol errors are structured; missing model never starts a recorder', async t => {
  const root = await scratch(t);
  const worker = spawn(process.execPath, ['voice/transcriber.mjs'], { env: { ...process.env, XDG_DATA_HOME: root } });
  let stdout = '', stderr = '';
  worker.stdout.on('data', b => stdout += b);
  worker.stderr.on('data', b => stderr += b);
  worker.stdin.end('oops\n{"cmd":"start"}\n{"cmd":"transcribe_file","path":"no.wav"}\n{"cmd":"stop"}\n{"cmd":"cancel"}\n');
  const code = await new Promise(resolve => worker.on('close', resolve));
  assert.equal(code, 0);
  assert.equal(stderr, '');
  const events = stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e => e.code || e.type), ['bad_command', 'model_missing', 'model_missing', 'empty_audio', 'cancelled']);
  assert.ok(events.filter(e => e.type === 'error').every(e => typeof e.message === 'string' && e.message));
  assert.deepEqual(await readdir(root), []);
});

function fakeWorker(options = {}) {
  const events = [];
  let loads = 0, decodes = 0;
  const recorder = new EventEmitter();
  recorder.stdout = new PassThrough();
  recorder.kill = () => { setImmediate(() => { recorder.stdout.end(); recorder.emit('close', 0); }); return true; };
  const runtime = {
    OfflineRecognizer: class {
      constructor(config) { loads++; assert.equal(config.modelConfig.modelType, 'nemo_transducer'); }
      createStream() { return { acceptWaveform: ({ samples }) => { assert.ok(samples.length > 0); } }; }
      decode() { decodes++; }
      getResult() { return { text: ' hello world ' }; }
    },
    readWave: () => ({ sampleRate: 16000, samples: new Float32Array(1600).fill(0.5) })
  };
  const worker = new Transcriber({ model: { status: async () => ({ state: 'installed', path: '/fake' }) },
    loadRuntime: async () => runtime, record: async () => recorder, emit: e => events.push(e), ...options });
  return { worker, recorder, events, counts: () => ({ loads, decodes }) };
}

test('capture reports level/time, stop transcribes, cancel discards, recognizer reused', async () => {
  const { worker, recorder, events, counts } = fakeWorker();
  await worker.handle({ cmd: 'start' });
  const bytes = Buffer.alloc(6400);
  for (let i = 0; i < 1600; i++) bytes.writeFloatLE(0.5, i * 4);
  recorder.stdout.write(bytes.subarray(0, 3));
  recorder.stdout.write(bytes.subarray(3));
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.ok(events.some(e => e.type === 'level' && e.rms === 0.5));
  assert.ok(events.some(e => e.type === 'recording' && e.seconds === 0.1));
  await worker.handle({ cmd: 'stop' });
  assert.deepEqual(events.at(-1), { type: 'transcript', text: 'hello world' });
  await worker.handle({ cmd: 'transcribe_file', path: 'test.wav' });
  assert.deepEqual(counts(), { loads: 1, decodes: 2 });
  await worker.handle({ cmd: 'start' });
  await worker.handle({ cmd: 'cancel' });
  assert.equal(events.at(-1).type, 'cancelled');
  assert.deepEqual(counts(), { loads: 1, decodes: 2 });
});

for (const code of ['runtime_missing', 'recorder_missing', 'empty_audio']) {
  test(`worker handles ${code} without transcripts`, async () => {
    const options = code === 'runtime_missing' ? { loadRuntime: async () => { throw Error('not installed'); } }
      : code === 'recorder_missing' ? { record: async () => { throw Object.assign(Error('Install pw-record or parec.'), { code }); } } : {};
    const { worker, events } = fakeWorker(options);
    await worker.handle({ cmd: 'start' });
    if (code === 'empty_audio') await worker.handle({ cmd: 'stop' });
    assert.equal(events.at(-1).code, code);
    assert.equal(events.filter(e => e.type === 'transcript').length, 0);
  });
}

const brokenRuntime = () => ({ OfflineRecognizer: class { constructor() { throw Error('Failed to create offline recognizer'); } } });

test('a recognizer load failure on a damaged model reports model_damaged', async t => {
  const events = [];
  const model = await installed(t, { 'encoder.int8.onnx': 'encodeX' });
  const worker = new Transcriber({ model, loadRuntime: async () => brokenRuntime(), emit: e => events.push(e),
    record: async () => { throw Error('recorder must not start'); } });
  await worker.handle({ cmd: 'start' });
  assert.deepEqual(events, [{ type: 'error', code: 'model_damaged',
    message: 'The voice model is damaged (encoder.int8.onnx). Download it again in Settings → Voice.' }]);
  assert.equal(worker.state, 'idle');
});

test('a recognizer load failure on an intact model stays transcriber_error', async t => {
  const events = [];
  const worker = new Transcriber({ model: await installed(t), loadRuntime: async () => brokenRuntime(), emit: e => events.push(e) });
  await worker.handle({ cmd: 'transcribe_file', path: 'x.wav' });
  assert.deepEqual(events, [{ type: 'error', code: 'transcriber_error', message: 'Failed to create offline recognizer' }]);
});

test('a size-damaged model is reported before the runtime loads', async t => {
  const events = [];
  let loads = 0;
  const worker = new Transcriber({ model: await installed(t, { 'tokens.txt': 'tokens, but longer' }),
    loadRuntime: async () => { loads++; return brokenRuntime(); }, emit: e => events.push(e) });
  await worker.handle({ cmd: 'start' });
  assert.deepEqual(events, [{ type: 'error', code: 'model_damaged',
    message: 'The voice model is damaged (tokens.txt). Download it again in Settings → Voice.' }]);
  assert.equal(loads, 0);
});

test('model CLI check reports a missing model', async t => {
  const dir = await scratch(t);
  const out = execFileSync(process.execPath, ['voice/model.mjs', 'check'], { env: { ...process.env, XDG_DATA_HOME: dir }, encoding: 'utf8' });
  const event = JSON.parse(out.trim().split('\n').pop());
  assert.equal(event.type, 'model');
  assert.equal(event.state, 'missing');
  assert.equal(event.missing.length, 4);
});

test('shared QML service: prepare/send modes, failed sends preserve draft, setting preserves connection', async t => {
  try { execFileSync('qs', ['--version']); } catch { return t.skip('Quickshell is not installed.'); }
  const dir = await scratch(t);
  const plugin = resolve('.');
  await writeFile(join(dir, 'shell.qml'), `
import QtQuick
import Quickshell
import "${pathToFileURL(plugin).href}" as Plugin
ShellRoot {
  Plugin.Client {
    id: client
    property var sent: []
    property var saved: null
    property bool allowSend: true
    shell: QtObject { function updateEntryInline(id, settings) { client.saved = settings; return true } }
    function sendText(text) { if (!allowSend) return false; sent = sent.concat([text]); return true }
  }
  Plugin.Voice {
    id: voice
    client: client
    property var commands: []
    function request(command) { commands = commands.concat([command]) }
    property var managed: []
    function manage(command) { managed = managed.concat([command]); return true }
    onTranscriptReady: function(text, sendNow) { client.acceptVoiceTranscript(text, sendNow) }
  }
  Timer { interval: 1; running: true; onTriggered: {
    try {
      client.draft = "existing"
      client.acceptVoiceTranscript("hello", false)
      if (client.draft !== "existing hello" || client.sent.length !== 0) throw Error("prepare")
      client.acceptVoiceTranscript("send this", true)
      if (client.sent.join() !== "send this" || client.draft !== "existing hello") throw Error("send")
      client.allowSend = false
      client.acceptVoiceTranscript("keep this", true)
      if (client.draft !== "existing hello keep this") throw Error("failed send lost text")
      client.entrySettings = {serverUrl: "wss://mac.example/ws", tokenFile: "unchanged", nodePath: "node"}
      if (!client.saveVoiceSendOnStop(true) || !client.saved.voiceSendOnStop || client.saved.serverUrl !== "wss://mac.example/ws" || client.saved.tokenFile !== "unchanged") throw Error("settings")
      client.entrySettings = {voiceSendOnStop: true}
      client.draft = ""
      client.sent = []
      client.allowSend = true
      voice.modelState = "installed"
      voice.start()
      voice.handleWorker(JSON.stringify({type: "recording", seconds: 2}))
      if (voice.state !== "recording" || voice.seconds !== 2) throw Error("recording")
      voice.stop()
      voice.handleWorker(JSON.stringify({type: "transcript", text: "send mode"}))
      if (client.sent.join() !== "send mode") throw Error("stop mode")
      voice.transcribeFile("fake.wav")
      voice.handleWorker(JSON.stringify({type: "transcript", text: "file only draft"}))
      if (client.sent.length !== 1 || client.draft !== "file only draft") throw Error("file sent to daemon")
      voice.start()
      voice.cancel()
      voice.handleWorker(JSON.stringify({type: "transcript", text: "stale"}))
      voice.handleWorker(JSON.stringify({type: "cancelled"}))
      if (client.sent.length !== 1 || client.draft !== "file only draft" || voice.active) throw Error("cancel")
      voice.modelState = "installed"
      voice.handleWorker(JSON.stringify({type: "error", code: "model_damaged", message: "The voice model is damaged (encoder.int8.onnx). Download it again in Settings → Voice."}))
      if (voice.modelState !== "damaged" || voice.error.indexOf("encoder.int8.onnx") < 0 || voice.active) throw Error("damaged state")
      voice.handleModel(JSON.stringify({type: "model", state: "damaged", damaged: ["joiner.int8.onnx"]}))
      if (voice.damagedFiles.join() !== "joiner.int8.onnx") throw Error("damaged files")
      voice.managed = []
      if (!voice.redownload() || voice.managed.join() !== "redownload") throw Error("redownload " + voice.managed)
      voice.modelState = "missing"
      voice.start()
      if (client.view !== "settings" || client.settingsSection !== "voice") throw Error("missing model settings")
      console.log("VOICE_QML_PASS")
    } catch (error) { console.log("VOICE_QML_FAIL: " + error) }
    Qt.quit()
  } }
}`);
  const child = spawn('qs', ['-p', join(dir, 'shell.qml'), '--no-duplicate'], {
    env: { ...process.env, QT_QPA_PLATFORM: 'offscreen', XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir, XDG_RUNTIME_DIR: dir, XDG_CONFIG_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', b => output += b);
  child.stderr.on('data', b => output += b);
  const timer = setTimeout(() => child.kill('SIGTERM'), 15000 * SCALE);
  const code = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.match(output, /VOICE_QML_PASS/);
  assert.doesNotMatch(output, /VOICE_QML_FAIL/);
});

test('real model transcribes a shipped WAV (optional)', { timeout: 120000 }, async t => {
  const manager = new ModelManager();
  const status = await manager.status();
  if (status.state !== 'installed') return t.skip('Parakeet not downloaded; use node voice/model.mjs download.');
  // The speech runtime is optional too. Skip only when it is installed nowhere; one that is there
  // but does not load fails with the loader's reason (the worker would only say runtime_missing).
  try {
    loadRuntime();
  } catch (error) {
    if (/is not installed in/.test(error.detail)) return t.skip('Speech runtime not installed; Settings → Voice → Enable voice.');
    assert.fail(`the speech runtime is installed but does not load: ${error.detail}`);
  }
  const files = await readdir(join(status.path, 'test_wavs'));
  const events = [];
  const worker = new Transcriber({ emit: e => events.push(e) });
  await worker.handle({ cmd: 'transcribe_file', path: join(status.path, 'test_wavs', files.find(f => f.endsWith('.wav'))) });
  assert.equal(events.at(-1).type, 'transcript', JSON.stringify(events));
  assert.ok(events.at(-1).text.trim());
});

// The Omarchy shell runs the plugin from ~/.config/omarchy/plugins/<id>, usually a symlink to a
// checkout; Node resolves import.meta.url through it, so the CLI guard must too.
test('voice CLIs run when invoked through a symlinked plugin directory', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gd-symlink-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const link = join(dir, 'plugin');
  execFileSync('ln', ['-s', resolve('.'), link]);
  const env = { ...process.env, XDG_DATA_HOME: join(dir, 'data') };

  const status = execFileSync(process.execPath, [join(link, 'voice', 'model.mjs'), 'status'], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(status.trim().split('\n').pop()).type, 'model');

  const worker = spawn(process.execPath, [join(link, 'voice', 'transcriber.mjs')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  worker.stdout.on('data', (chunk) => (out += chunk));
  worker.stdin.end('{"cmd":"cancel"}\n');
  await new Promise((done) => worker.on('exit', done));
  assert.notEqual(out.trim(), '', 'the transcriber answered nothing when run through the symlink');
});
