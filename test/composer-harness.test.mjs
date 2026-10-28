import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

// Only offscreen QML windows receive simulated test keys.
export async function qml(t, body, { timeout = 15000, files = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gentle-qml-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await symlink('/usr/share/omarchy/shell/Commons', join(dir, 'Commons'));
  await symlink('/usr/share/omarchy/shell/Ui', join(dir, 'Ui'));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content, { mode: 0o700 });
  await writeFile(join(dir, 'shell.qml'), `
import QtQuick
import QtTest
import Quickshell
import "${pathToFileURL(resolve('.')).href}" as Plugin
ShellRoot { ${body} }
`);
  const child = spawn('qs', ['-p', join(dir, 'shell.qml'), '--no-duplicate'], {
    env: { ...process.env, QT_QPA_PLATFORM: 'offscreen', XDG_DATA_HOME: dir,
      XDG_CACHE_HOME: dir, XDG_RUNTIME_DIR: dir, XDG_CONFIG_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', b => output += b);
  child.stderr.on('data', b => output += b);
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  const code = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.match(output, /QML_PASS/, output);
  assert.doesNotMatch(output, /QML_FAIL|TypeError|ReferenceError/, output);
}
