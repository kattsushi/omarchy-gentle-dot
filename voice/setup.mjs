#!/usr/bin/env node
// Settings → Voice → Enable voice in one step: the speech runtime (runtime.mjs), then the model
// (model.mjs), then a check for a recorder. NDJSON on stdout, like model.mjs.
import { realpathSync } from 'node:fs';
import { access, constants, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelManager } from './model.mjs';
import { RuntimeInstaller, runtimeStatus } from './runtime.mjs';
import { RECORDER_COMMANDS, RECORDER_MISSING } from './transcriber.mjs';

// The first recorder transcriber.mjs would use that is an executable file on PATH.
export async function findRecorder(path = process.env.PATH || '') {
  for (const [command] of RECORDER_COMMANDS) {
    for (const dir of path.split(':').filter(Boolean)) {
      const file = join(dir, command);
      const found = await stat(file).then(s => s.isFile()).catch(() => false)
        && await access(file, constants.X_OK).then(() => true, () => false);
      if (found) return command;
    }
  }
  return null;
}

export async function recorderStatus() {
  const command = await findRecorder();
  return command ? { type: 'recorder', state: 'found', command }
    : { type: 'recorder', state: 'missing', command: '', message: RECORDER_MISSING };
}

const defaultRuntime = () => {
  const installer = new RuntimeInstaller();
  return { status: () => runtimeStatus(), install: (emit, signal) => installer.install(emit, signal) };
};

// A runtime that already loads (installed before, or a developer checkout's node_modules) is kept.
export async function enableVoice({ runtime = defaultRuntime(), model = new ModelManager(), recorder = recorderStatus,
  emit = () => {}, signal } = {}) {
  let current = await runtime.status();
  emit(current);
  if (current.state !== 'installed') {
    current = await runtime.install(emit, signal);
    emit(current);
  }
  emit({ type: 'setup', step: 'model', state: 'downloading' });
  emit(await model.download(emit, signal));
  emit({ type: 'setup', step: 'recorder', state: 'checking' });
  const found = await recorder();
  emit(found);
  emit({ type: 'setup', step: 'done', state: found.state === 'found' ? 'ready' : 'needs_recorder' });
}

// realpath: the shell runs the plugin through a symlinked directory, and import.meta.url is resolved.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  const usage = 'Usage: node voice/setup.mjs [status|enable]';
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => controller.abort(Error('Voice setup cancelled.')));
  try {
    switch (process.argv[2] || 'status') {
      case 'status': emit(runtimeStatus()); emit(await recorderStatus()); break;
      case 'enable': await enableVoice({ emit, signal: controller.signal }); break;
      case '--help': console.log(usage + '\nstatus: is the speech runtime loadable, is there a recorder.\nenable: install the runtime with npm into $XDG_DATA_HOME/omarchy-gentle-dot/runtime if needed, download the model, check the recorder.\nSIGTERM/SIGINT cancel and clean partial files.'); break;
      default: throw Error(usage);
    }
  } catch (error) {
    const cancelled = controller.signal.aborted;
    emit({ type: 'error', code: cancelled ? 'cancelled' : error.code || 'setup_error', message: cancelled ? 'Voice setup cancelled.' : error.message });
    process.exitCode = cancelled ? 0 : 1;
    // What is on disk now, so the panel shows the real state after a failure.
    emit(runtimeStatus());
    const model = await new ModelManager().status().catch(() => null);
    if (model) emit(model);
  }
}
