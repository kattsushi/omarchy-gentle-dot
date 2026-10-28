#!/usr/bin/env node
// Optional client-side model. Nothing is downloaded by importing this module.
import { createReadStream, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, open, lstat, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const SPEC = Object.freeze({
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
  sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
  size: 487170055,
  archiveRoot: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  dir: 'parakeet-tdt-0.6b-v3-int8',
  // Per-file size and SHA-256 (Hugging Face csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8, same as the tarball).
  files: Object.freeze([
    { name: 'encoder.int8.onnx', size: 652184281, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' },
    { name: 'decoder.int8.onnx', size: 11845275, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
    { name: 'joiner.int8.onnx', size: 6355277, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
    { name: 'tokens.txt', size: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' }
  ].map(Object.freeze))
});
export const defaultRoot = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'omarchy-gentle-dot/models');

export class ModelManager {
  constructor({ root = defaultRoot(), spec = SPEC, fetcher = fetch } = {}) {
    this.root = root;
    this.spec = spec;
    this.fetcher = fetcher;
    this.path = join(root, spec.dir);
  }

  // Cheap: existence and size only, safe to run on every panel open.
  async verify(path = this.path) {
    const missing = [], damaged = [];
    for (const { name, size } of this.spec.files) {
      const stat = await lstat(join(path, name)).catch(() => null);
      if (!stat?.isFile() || stat.size === 0) missing.push(name);
      else if (stat.size !== size) damaged.push(name);
    }
    const state = missing.length ? 'missing' : damaged.length ? 'damaged' : 'installed';
    return { type: 'model', state, path, missing, damaged };
  }

  async status() { return this.verify(); }

  // Deep: streams every file through SHA-256 (a same-size bit flip passes verify()).
  async check(path = this.path) {
    const result = await this.verify(path);
    if (result.state !== 'installed') return result;
    for (const { name, sha256 } of this.spec.files) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(join(path, name), { highWaterMark: 1 << 20 })) hash.update(chunk);
      if (hash.digest('hex') !== sha256) result.damaged.push(name);
    }
    if (result.damaged.length) result.state = 'damaged';
    return result;
  }

  // Shared cross-process exclusion for download/remove. Never clear another job's lock.
  async exclusive(action) {
    await mkdir(this.root, { recursive: true });
    const lock = join(this.root, '.' + this.spec.dir + '.lock');
    try { await mkdir(lock); }
    catch (error) {
      if (error.code === 'EEXIST') throw Error('Model is busy; another download or removal is running.');
      throw error;
    }
    try { return await action(); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }

  async download(emit = () => {}, signal) {
    return this.exclusive(() => this.install(emit, signal));
  }

  // "Download again": remove + download under one lock, for a damaged model.
  async redownload(emit = () => {}, signal) {
    return this.exclusive(async () => {
      await rm(this.path, { recursive: true, force: true });
      return this.install(emit, signal);
    });
  }

  // Callers hold the exclusive lock.
  async install(emit, signal) {
    const current = await this.status();
    if (current.state === 'installed') return current;
    if (current.state === 'damaged') throw Error('The installed model is damaged; download it again (redownload).');
    const stage = await mkdtemp(join(this.root, '.download-'));
    try {
      const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30 * 60 * 1000)]);
      combined.throwIfAborted();
      const archive = join(stage, 'archive.part');
      const file = await open(archive, 'wx');
      let received = 0, last = 0;
      const hash = createHash('sha256');
      const progress = () => emit({ type: 'progress', received, total: this.spec.size });
      progress();
      try {
        const response = await this.fetcher(this.spec.url, { signal: combined });
        if (!response.ok || !response.body) throw Error(`Download failed: HTTP ${response.status}`);
        for await (const chunk of response.body) {
          combined.throwIfAborted();
          received += chunk.length;
          if (received > this.spec.size) throw Error('The download was not the expected size.');
          hash.update(chunk);
          await file.writeFile(chunk);
          if (Date.now() - last >= 250) { progress(); last = Date.now(); }
        }
        await file.sync();
      } finally { await file.close(); }
      progress();
      if (received !== this.spec.size) throw Error('The download was not the expected size.');
      if (hash.digest('hex') !== this.spec.sha256) throw Error('The download did not match the published checksum.');
      emit({ type: 'model', state: 'verifying' });
      // Extraction is allowed only after the pinned size and SHA-256 match.
      await exec('tar', ['-xjf', archive, '-C', stage, '--no-same-owner', '--no-same-permissions'], { signal: combined });
      const extracted = join(stage, this.spec.archiveRoot);
      const verified = await this.check(extracted);
      if (verified.missing.length) throw Error('Model files missing: ' + verified.missing.join(', '));
      if (verified.damaged.length) throw Error('Model files did not match the published checksums: ' + verified.damaged.join(', '));
      combined.throwIfAborted();
      // An incomplete installation must be removed explicitly, not overwritten.
      await rename(extracted, this.path);
      return this.status();
    } finally { await rm(stage, { recursive: true, force: true }); }
  }

  async remove() {
    return this.exclusive(async () => {
      await rm(this.path, { recursive: true, force: true });
      return this.status();
    });
  }
}

// realpath: the shell runs the plugin through a symlinked directory, and import.meta.url is resolved.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  const usage = 'Usage: node voice/model.mjs [status|verify|check|download|redownload|remove]';
  const manager = new ModelManager();
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort(Error('Download cancelled.')));
  process.on('SIGINT', () => controller.abort(Error('Download cancelled.')));
  try {
    switch (process.argv[2] || 'status') {
      case 'status': case 'verify': emit(await manager.status()); break;
      case 'check': emit(await manager.check()); break;
      case 'download': emit(await manager.download(emit, controller.signal)); break;
      case 'redownload': emit(await manager.redownload(emit, controller.signal)); break;
      case 'remove': emit(await manager.remove()); break;
      case '--help': console.log(usage + '\nstatus: files exist with the pinned sizes (fast). check: also SHA-256 every file (reads ~670 MB).\nredownload: remove, then download. NDJSON on stdout. SIGTERM/SIGINT cancel download and clean partial files.'); break;
      default: throw Error(usage);
    }
  } catch (error) {
    emit({ type: 'error', code: controller.signal.aborted ? 'cancelled' : 'model_error', message: error.message });
    process.exitCode = controller.signal.aborted ? 0 : 1;
    // A failed download/redownload may have changed what is on disk: report the current state.
    const status = await manager.status().catch(() => null);
    if (status) emit(status);
  }
}
