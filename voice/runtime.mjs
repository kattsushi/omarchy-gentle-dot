#!/usr/bin/env node
// The optional speech runtime (sherpa-onnx-node), kept outside the plugin folder: Omarchy's
// installer never runs plugin code and its validator refuses symlinks in the plugin folder, so
// Settings → Voice → Enable voice installs it with npm into $XDG_DATA_HOME/omarchy-gentle-dot/runtime.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const RUNTIME = Object.freeze({ name: 'sherpa-onnx-node', version: '2.0.1' });
const LABEL = `${RUNTIME.name} ${RUNTIME.version}`;
export const RUNTIME_MISSING = 'Voice needs a one-time setup: Settings → Voice → Enable voice.';
export const NPM_MISSING = 'Voice setup needs npm, which comes with Node.js. Install Node.js 22 or newer (e.g. `omarchy pkg add nodejs npm` or mise) and try again.';
export const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));
const fail = (code, message, extra) => Object.assign(Error(message), { code }, extra);

export const dataDir = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'omarchy-gentle-dot');
export const defaultRuntimeDir = () => join(dataDir(), 'runtime');
// GENTLE_DOT_PLUGIN_RUNTIME=off ignores a developer checkout's node_modules (tests).
const defaultPluginDir = () => process.env.GENTLE_DOT_PLUGIN_RUNTIME === 'off' ? null : PLUGIN_DIR;

export const npmArgs = dir => ['install', '--prefix', dir, '--no-save', '--no-package-lock', '--omit=dev',
  '--no-bin-links', '--no-audit', '--no-fund', `${RUNTIME.name}@${RUNTIME.version}`];

// The npm that ships with this Node, run by this Node (its shebang could find another one);
// npm on PATH otherwise. GENTLE_DOT_NPM replaces it (tests).
export function npmCommand(execPath = process.execPath, env = process.env) {
  if (env.GENTLE_DOT_NPM) return [env.GENTLE_DOT_NPM];
  const cli = join(dirname(execPath), '..', 'lib/node_modules/npm/bin/npm-cli.js');
  return existsSync(cli) ? [execPath, resolve(cli)] : ['npm'];
}

// Loads the pinned package from <dir>/node_modules only (createRequire would also search parents).
function loadFrom(dir) {
  const pkg = join(dir, 'node_modules', RUNTIME.name);
  let version;
  try { version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version; }
  catch { return { error: `${RUNTIME.name} is not installed in ${dir}` }; }
  if (version !== RUNTIME.version) return { error: `${dir} has ${RUNTIME.name} ${version}, not ${RUNTIME.version}` };
  try { return { module: createRequire(join(dir, 'noop.cjs'))(pkg), version }; }
  catch (error) { return { error: error.message }; }
}

// The runtime dir first, then the plugin's own node_modules (a developer checkout).
export function loadRuntime({ runtimeDir = defaultRuntimeDir(), pluginDir = defaultPluginDir() } = {}) {
  const errors = [];
  for (const [source, dir] of [['runtime', runtimeDir], ['plugin', pluginDir]]) {
    if (!dir) continue;
    const loaded = loadFrom(dir);
    if (loaded.module) return { module: loaded.module, source, version: loaded.version, dir };
    errors.push(loaded.error);
  }
  throw fail('runtime_missing', RUNTIME_MISSING, { detail: errors.find(error => !/is not installed in/.test(error)) || errors[0] || '' });
}

export function runtimeStatus({ runtimeDir = defaultRuntimeDir(), pluginDir = defaultPluginDir() } = {}) {
  try {
    const { source, version } = loadRuntime({ runtimeDir, pluginDir });
    return { type: 'runtime', state: 'installed', source, version, dir: runtimeDir };
  } catch {
    return { type: 'runtime', state: 'missing', source: '', version: '', dir: runtimeDir, message: RUNTIME_MISSING };
  }
}

// Runs a command; rejects with the last stderr line. The signal kills it (cancel).
function runNpm([command, ...prefix], args, { cwd, signal }) {
  return new Promise((done, reject) => {
    const child = spawn(command, [...prefix, ...args], { cwd, signal, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false' } });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', error => reject(error.code === 'ENOENT' ? fail('npm_missing', NPM_MISSING) : error));
    child.once('close', code => {
      if (signal?.aborted) return reject(signal.reason);
      if (code === 0) return done();
      const last = stderr.trim().split('\n').filter(Boolean).at(-1) || '';
      reject(fail('runtime_install_failed', `Installing ${LABEL} failed (npm exit ${code})${last ? ': ' + last : '.'}`));
    });
  });
}

export class RuntimeInstaller {
  constructor({ dir = defaultRuntimeDir(), npm = npmCommand() } = {}) {
    this.dir = dir;
    this.root = dirname(dir);
    this.npm = npm;
  }

  // In a fresh Node process: a native library that fails to load must not take the installer down.
  async probe(dir) {
    try {
      const { stdout } = await exec(process.execPath, [fileURLToPath(import.meta.url), 'probe', dir],
        { env: { ...process.env, GENTLE_DOT_PLUGIN_RUNTIME: 'off' } });
      return JSON.parse(stdout.trim().split('\n').pop());
    } catch (error) {
      const out = String(error.stdout || '').trim().split('\n').pop();
      let message = String(error.stderr || error.message).trim().split('\n').pop();
      try { message = JSON.parse(out).detail || message; } catch {}
      return { state: 'missing', detail: message };
    }
  }

  async install(emit = () => {}, signal) {
    await mkdir(this.root, { recursive: true });
    const lock = join(this.root, '.runtime.lock');
    try { await mkdir(lock); }
    catch (error) {
      if (error.code === 'EEXIST') throw fail('busy', 'Voice setup is already running.');
      throw error;
    }
    const stage = await mkdtemp(join(this.root, '.runtime-'));
    try {
      emit({ type: 'setup', step: 'runtime', state: 'installing', version: RUNTIME.version });
      await runNpm(this.npm, npmArgs(stage), { cwd: stage, signal });
      emit({ type: 'setup', step: 'runtime', state: 'verifying' });
      const probe = await this.probe(stage);
      if (probe.state !== 'installed') throw fail('runtime_broken', `${LABEL} was installed but does not load: ${probe.detail}`);
      signal?.throwIfAborted();
      await rm(this.dir, { recursive: true, force: true });
      await rename(stage, this.dir);
      const final = await this.probe(this.dir);
      if (final.state !== 'installed') throw fail('runtime_broken', `${LABEL} was installed but does not load: ${final.detail}`);
      return { type: 'runtime', state: 'installed', source: 'runtime', version: RUNTIME.version, dir: this.dir };
    } catch (error) {
      if (signal?.aborted) throw fail('cancelled', 'Voice setup cancelled.');
      throw error;
    } finally {
      await rm(stage, { recursive: true, force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}

// realpath: the shell runs the plugin through a symlinked directory, and import.meta.url is resolved.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const [command = 'status', dir] = process.argv.slice(2);
  if (command === 'probe' && dir) {
    try {
      const { version } = loadRuntime({ runtimeDir: dir, pluginDir: null });
      console.log(JSON.stringify({ state: 'installed', version }));
    } catch (error) {
      console.log(JSON.stringify({ state: 'missing', detail: error.detail || error.message }));
      process.exitCode = 1;
    }
  } else if (command === 'status') console.log(JSON.stringify(runtimeStatus()));
  else {
    console.error('Usage: node voice/runtime.mjs [status|probe <dir>]\nInstalling is done by node voice/setup.mjs enable.');
    process.exitCode = 2;
  }
}
