import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, truncate, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RUNTIME, RUNTIME_MISSING, defaultRuntimeDir, npmArgs, npmCommand, loadRuntime, runtimeStatus, RuntimeInstaller }
  from '../voice/runtime.mjs';
import { enableVoice, findRecorder } from '../voice/setup.mjs';
import { Transcriber } from '../voice/transcriber.mjs';
import { SPEC } from '../voice/model.mjs';

const run = promisify(execFile);

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A fake sherpa-onnx-node package under <dir>/node_modules: `body` is its index.js.
async function fakePackage(dir, { version = RUNTIME.version, body = 'module.exports = { source: "fake" };' } = {}) {
  const pkg = join(dir, 'node_modules', RUNTIME.name);
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: RUNTIME.name, version, main: 'index.js' }));
  await writeFile(join(pkg, 'index.js'), body);
}

// A fake npm (a Node script, so it needs no PATH): logs its argv, then acts on FAKE_NPM_MODE.
async function fakeNpm(dir, mode) {
  const file = join(dir, 'fake-npm');
  await writeFile(file, `#!${process.execPath}
const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'npm.log'))}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const mode = ${JSON.stringify(mode)};
if (mode === 'fail') { console.error('npm error code E404'); console.error('npm error 404 Not Found - sherpa-onnx-node'); process.exit(1); }
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
const prefix = args[args.indexOf('--prefix') + 1];
const pkg = join(prefix, 'node_modules', 'sherpa-onnx-node');
mkdirSync(pkg, { recursive: true });
writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'sherpa-onnx-node', version: '2.0.1', main: 'index.js' }));
writeFileSync(join(pkg, 'index.js'), mode === 'broken' ? 'throw new Error("libonnxruntime.so: cannot open shared object file")' : 'module.exports = { source: "installed" };');
`);
  await chmod(file, 0o755);
  return file;
}

const npmLog = async dir => (await readFile(join(dir, 'npm.log'), 'utf8')).trim().split('\n').map(JSON.parse);

test('the runtime is pinned and installed with npm outside the plugin folder', () => {
  assert.deepEqual(RUNTIME, { name: 'sherpa-onnx-node', version: '2.0.1' });
  assert.equal(RUNTIME_MISSING, 'Voice needs a one-time setup: Settings → Voice → Enable voice.');
  assert.deepEqual(npmArgs('/data/omarchy-gentle-dot/runtime'), ['install', '--prefix', '/data/omarchy-gentle-dot/runtime',
    '--no-save', '--no-package-lock', '--omit=dev', '--no-bin-links', '--no-audit', '--no-fund', 'sherpa-onnx-node@2.0.1']);
  const saved = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = '/scratch/data';
    assert.equal(defaultRuntimeDir(), '/scratch/data/omarchy-gentle-dot/runtime');
    delete process.env.XDG_DATA_HOME;
    assert.match(defaultRuntimeDir(), /\/\.local\/share\/omarchy-gentle-dot\/runtime$/);
  } finally {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
  }
  assert.ok(!defaultRuntimeDir().startsWith(resolve('.')), 'never inside the plugin folder');
});

test('npm is the one that ships with the running Node, run by that Node; GENTLE_DOT_NPM overrides it', async t => {
  const dir = await scratch(t);
  const bin = join(dir, 'bin'), cli = join(dir, 'lib/node_modules/npm/bin/npm-cli.js');
  await mkdir(bin, { recursive: true });
  await mkdir(join(dir, 'lib/node_modules/npm/bin'), { recursive: true });
  await writeFile(cli, '');
  assert.deepEqual(npmCommand(join(bin, 'node'), {}), [join(bin, 'node'), cli]);
  assert.deepEqual(npmCommand(join(dir, 'other/bin/node'), {}), ['npm']);
  assert.deepEqual(npmCommand(join(bin, 'node'), { GENTLE_DOT_NPM: '/opt/fake-npm' }), ['/opt/fake-npm']);
});

test('the runtime loads from the runtime dir first, then the plugin node_modules, else runtime_missing', async t => {
  const dir = await scratch(t);
  const runtimeDir = join(dir, 'runtime'), pluginDir = join(dir, 'plugin');
  await fakePackage(runtimeDir, { body: 'module.exports = { source: "runtime" };' });
  await fakePackage(pluginDir, { body: 'module.exports = { source: "plugin" };' });
  let loaded = loadRuntime({ runtimeDir, pluginDir });
  assert.deepEqual({ source: loaded.source, version: loaded.version, from: loaded.module.source },
    { source: 'runtime', version: '2.0.1', from: 'runtime' });

  // A runtime dir without the package (or another version) falls back to the plugin's.
  loaded = loadRuntime({ runtimeDir: join(dir, 'empty'), pluginDir });
  assert.deepEqual({ source: loaded.source, from: loaded.module.source }, { source: 'plugin', from: 'plugin' });
  const stale = join(dir, 'stale');
  await fakePackage(stale, { version: '1.12.0', body: 'module.exports = { source: "stale" };' });
  assert.equal(loadRuntime({ runtimeDir: stale, pluginDir }).source, 'plugin');

  // A package that is there but cannot load is skipped too.
  const broken = join(dir, 'broken');
  await fakePackage(broken, { body: 'throw new Error("cannot open shared object file")' });
  assert.equal(loadRuntime({ runtimeDir: broken, pluginDir }).source, 'plugin');

  assert.throws(() => loadRuntime({ runtimeDir: join(dir, 'none'), pluginDir: join(dir, 'none') }),
    error => error.code === 'runtime_missing' && error.message === RUNTIME_MISSING);
  assert.throws(() => loadRuntime({ runtimeDir: broken, pluginDir: join(dir, 'none') }),
    error => error.code === 'runtime_missing' && error.message === RUNTIME_MISSING && /shared object/.test(error.detail));

  assert.deepEqual(runtimeStatus({ runtimeDir, pluginDir }),
    { type: 'runtime', state: 'installed', source: 'runtime', version: '2.0.1', dir: runtimeDir });
  assert.deepEqual(runtimeStatus({ runtimeDir: join(dir, 'none'), pluginDir: join(dir, 'none') }),
    { type: 'runtime', state: 'missing', source: '', version: '', dir: join(dir, 'none'), message: RUNTIME_MISSING });
});

test('the transcriber reports runtime_missing with the setup message', async () => {
  const events = [];
  const worker = new Transcriber({ model: { status: async () => ({ state: 'installed', path: '/fake' }) },
    loadRuntime: async () => { throw Object.assign(Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' }); },
    record: async () => { throw Error('recorder must not start'); }, emit: e => events.push(e) });
  await worker.handle({ cmd: 'start' });
  assert.deepEqual(events, [{ type: 'error', code: 'runtime_missing', message: RUNTIME_MISSING }]);
});

test('install runs npm with the pinned arguments into a staging dir, verifies the module loads, then moves it in place', async t => {
  const dir = await scratch(t);
  const runtimeDir = join(dir, 'data/omarchy-gentle-dot/runtime');
  const events = [];
  const installer = new RuntimeInstaller({ dir: runtimeDir, npm: [await fakeNpm(dir, 'ok')] });
  const result = await installer.install(e => events.push(e));
  const [call] = await npmLog(dir);
  const prefix = call.args[2];
  assert.deepEqual(call.args, npmArgs(prefix));
  assert.match(prefix, new RegExp('^' + join(dir, 'data/omarchy-gentle-dot/.runtime-')));
  assert.equal(call.cwd, prefix);
  assert.deepEqual(result, { type: 'runtime', state: 'installed', source: 'runtime', version: '2.0.1', dir: runtimeDir });
  assert.deepEqual(events.map(e => e.type + ':' + (e.step || '') + ':' + e.state), ['setup:runtime:installing', 'setup:runtime:verifying']);
  assert.deepEqual(await readdir(join(dir, 'data/omarchy-gentle-dot')), ['runtime']);
  assert.equal(loadRuntime({ runtimeDir, pluginDir: join(dir, 'none') }).module.source, 'installed');
});

for (const [mode, code, message] of [
  ['fail', 'runtime_install_failed', 'Installing sherpa-onnx-node 2.0.1 failed (npm exit 1): npm error 404 Not Found - sherpa-onnx-node'],
  ['broken', 'runtime_broken', 'sherpa-onnx-node 2.0.1 was installed but does not load: libonnxruntime.so: cannot open shared object file']
]) {
  test(`install failure (${mode}) leaves nothing behind and keeps a working runtime`, async t => {
    const dir = await scratch(t);
    const root = join(dir, 'data/omarchy-gentle-dot');
    const runtimeDir = join(root, 'runtime');
    const installer = new RuntimeInstaller({ dir: runtimeDir, npm: [await fakeNpm(dir, mode)] });
    await assert.rejects(installer.install(), error => error.code === code && error.message === message);
    assert.deepEqual(await readdir(root), []);
    // An existing runtime is not replaced by a failed install.
    await fakePackage(runtimeDir, { body: 'module.exports = { source: "kept" };' });
    await assert.rejects(installer.install(), error => error.code === code);
    assert.deepEqual(await readdir(root), ['runtime']);
    assert.equal(loadRuntime({ runtimeDir, pluginDir: join(dir, 'none') }).module.source, 'kept');
  });
}

test('install without npm says what to install', async t => {
  const dir = await scratch(t);
  const installer = new RuntimeInstaller({ dir: join(dir, 'runtime'), npm: [join(dir, 'no-such-npm')] });
  await assert.rejects(installer.install(), error => error.code === 'npm_missing'
    && error.message === 'Voice setup needs npm, which comes with Node.js. Install Node.js 22 or newer (e.g. `omarchy pkg add nodejs npm` or mise) and try again.');
  assert.deepEqual(await readdir(dir), []);
});

test('cancel stops npm, cleans staging, and a second install is refused while one runs', async t => {
  const dir = await scratch(t);
  const root = join(dir, 'data');
  const installer = new RuntimeInstaller({ dir: join(root, 'runtime'), npm: [await fakeNpm(dir, 'hang')] });
  const controller = new AbortController();
  const first = installer.install(() => {}, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 300));
  await assert.rejects(installer.install(), error => error.code === 'busy' && error.message === 'Voice setup is already running.');
  controller.abort(Error('Voice setup cancelled.'));
  await assert.rejects(first, error => error.code === 'cancelled' && error.message === 'Voice setup cancelled.');
  assert.deepEqual(await readdir(root), []);
});

test('recorder lookup prefers pw-record, then parec, else missing', async t => {
  const dir = await scratch(t);
  const a = join(dir, 'a'), b = join(dir, 'b');
  await mkdir(a); await mkdir(b);
  assert.equal(await findRecorder([a, b].join(':')), null);
  await writeFile(join(b, 'parec'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(await findRecorder([a, b].join(':')), 'parec');
  await writeFile(join(a, 'pw-record'), 'not executable', { mode: 0o644 });
  assert.equal(await findRecorder([a, b].join(':')), 'parec');
  await writeFile(join(b, 'pw-record'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(await findRecorder([a, b].join(':')), 'pw-record');
});

function fakes({ runtimeState = 'missing', installError, modelError, recorder = 'pw-record' } = {}) {
  const calls = [];
  const runtime = {
    status: () => { calls.push('runtime.status'); return { type: 'runtime', state: runtimeState, source: runtimeState === 'installed' ? 'plugin' : '' }; },
    install: async emit => {
      calls.push('runtime.install');
      emit({ type: 'setup', step: 'runtime', state: 'installing' });
      if (installError) throw installError;
      return { type: 'runtime', state: 'installed', source: 'runtime' };
    }
  };
  const model = { download: async emit => {
    calls.push('model.download');
    if (modelError) throw modelError;
    emit({ type: 'progress', received: 1, total: 2 });
    return { type: 'model', state: 'installed' };
  } };
  const recorderStatus = async () => {
    calls.push('recorder');
    return recorder ? { type: 'recorder', state: 'found', command: recorder }
      : { type: 'recorder', state: 'missing', command: '', message: 'Install pw-record (PipeWire) or parec (pulseaudio-utils) to record voice.' };
  };
  return { calls, runtime, model, recorder: recorderStatus };
}

test('enable voice: runtime, then model, then recorder; an existing runtime is not reinstalled', async () => {
  let f = fakes();
  let events = [];
  await enableVoice({ ...f, emit: e => events.push(e) });
  assert.deepEqual(f.calls, ['runtime.status', 'runtime.install', 'model.download', 'recorder']);
  assert.deepEqual(events.map(e => [e.type, e.step || e.state].join(':')), ['runtime:missing', 'setup:runtime', 'runtime:installed',
    'setup:model', 'progress:', 'model:installed', 'setup:recorder', 'recorder:found', 'setup:done']);
  assert.deepEqual(events.at(-1), { type: 'setup', step: 'done', state: 'ready' });

  f = fakes({ runtimeState: 'installed', recorder: null });
  events = [];
  await enableVoice({ ...f, emit: e => events.push(e) });
  assert.deepEqual(f.calls, ['runtime.status', 'model.download', 'recorder']);
  assert.deepEqual(events.find(e => e.type === 'recorder'), { type: 'recorder', state: 'missing', command: '',
    message: 'Install pw-record (PipeWire) or parec (pulseaudio-utils) to record voice.' });
  assert.deepEqual(events.at(-1), { type: 'setup', step: 'done', state: 'needs_recorder' });
});

test('enable voice stops at a failed runtime install: no model download', async () => {
  const f = fakes({ installError: Object.assign(Error('npm failed'), { code: 'runtime_install_failed' }) });
  await assert.rejects(enableVoice({ ...f, emit: () => {} }), /npm failed/);
  assert.deepEqual(f.calls, ['runtime.status', 'runtime.install']);
});

// The model files exist with their pinned sizes (sparse), so status says installed without a download.
async function sparseModel(data) {
  const path = join(data, 'omarchy-gentle-dot/models', SPEC.dir);
  await mkdir(path, { recursive: true });
  for (const { name, size } of SPEC.files) { await writeFile(join(path, name), ''); await truncate(join(path, name), size); }
}

const cli = async (args, env) => {
  try {
    const { stdout } = await run(process.execPath, ['voice/setup.mjs', ...args], { env });
    return { code: 0, events: stdout.trim().split('\n').filter(Boolean).map(JSON.parse) };
  } catch (error) {
    return { code: error.code, events: String(error.stdout).trim().split('\n').filter(Boolean).map(JSON.parse) };
  }
};

test('setup CLI: status, then enable with a fake npm, a ready model and no recorder', async t => {
  const dir = await scratch(t);
  const data = join(dir, 'data'), bin = join(dir, 'bin');
  await mkdir(bin);
  await sparseModel(data);
  const env = { HOME: dir, XDG_DATA_HOME: data, PATH: bin, GENTLE_DOT_NPM: await fakeNpm(dir, 'ok'), GENTLE_DOT_PLUGIN_RUNTIME: 'off' };
  let { code, events } = await cli(['status'], env);
  assert.equal(code, 0);
  assert.deepEqual(events, [
    { type: 'runtime', state: 'missing', source: '', version: '', dir: join(data, 'omarchy-gentle-dot/runtime'), message: RUNTIME_MISSING },
    { type: 'recorder', state: 'missing', command: '', message: 'Install pw-record (PipeWire) or parec (pulseaudio-utils) to record voice.' }
  ]);
  ({ code, events } = await cli(['enable'], env));
  assert.equal(code, 0, JSON.stringify(events));
  assert.deepEqual(events.find(e => e.type === 'runtime' && e.state === 'installed'),
    { type: 'runtime', state: 'installed', source: 'runtime', version: '2.0.1', dir: join(data, 'omarchy-gentle-dot/runtime') });
  assert.equal(events.find(e => e.type === 'model').state, 'installed');
  assert.deepEqual(events.at(-1), { type: 'setup', step: 'done', state: 'needs_recorder' });
  assert.equal((await npmLog(dir)).length, 1);
  await writeFile(join(bin, 'pw-record'), '#!/bin/sh\n', { mode: 0o755 });
  ({ code, events } = await cli(['status'], env));
  assert.deepEqual(events.map(e => e.type + ':' + e.state + ':' + (e.source || e.command)), ['runtime:installed:runtime', 'recorder:found:pw-record']);
});

test('setup CLI: a failed install reports the error, then the current state, and exits 1', async t => {
  const dir = await scratch(t);
  const data = join(dir, 'data');
  const env = { HOME: dir, XDG_DATA_HOME: data, PATH: dir, GENTLE_DOT_NPM: await fakeNpm(dir, 'fail'), GENTLE_DOT_PLUGIN_RUNTIME: 'off' };
  const { code, events } = await cli(['enable'], env);
  assert.equal(code, 1);
  assert.deepEqual(events.find(e => e.type === 'error'), { type: 'error', code: 'runtime_install_failed',
    message: 'Installing sherpa-onnx-node 2.0.1 failed (npm exit 1): npm error 404 Not Found - sherpa-onnx-node' });
  assert.equal(events.at(-2).type, 'runtime');
  assert.equal(events.at(-2).state, 'missing');
  assert.equal(events.at(-1).type, 'model');
  assert.ok(!events.some(e => e.type === 'progress'), 'no model download after a failed runtime install');
});

test('setup CLI: SIGTERM cancels a running install cleanly', async t => {
  const dir = await scratch(t);
  const data = join(dir, 'data');
  const env = { HOME: dir, XDG_DATA_HOME: data, PATH: dir, GENTLE_DOT_NPM: await fakeNpm(dir, 'hang'), GENTLE_DOT_PLUGIN_RUNTIME: 'off' };
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['voice/setup.mjs', 'enable'], { env });
  let out = '';
  child.stdout.on('data', b => {
    out += b;
    if (out.includes('"installing"')) setTimeout(() => child.kill('SIGTERM'), 200);
  });
  const code = await new Promise(resolve => child.on('close', resolve));
  const events = out.trim().split('\n').map(JSON.parse);
  assert.equal(code, 0);
  assert.deepEqual(events.find(e => e.type === 'error'), { type: 'error', code: 'cancelled', message: 'Voice setup cancelled.' });
  assert.deepEqual(await readdir(join(data, 'omarchy-gentle-dot')).then(list => list.filter(name => !name.startsWith('models'))), []);
});
