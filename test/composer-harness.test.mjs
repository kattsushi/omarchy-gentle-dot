import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

// `node --test` runs the files in parallel, so a QML scene may start late and run slowly.
// QML_TEST_TIMEOUT_SCALE (default 1) stretches every harness deadline on a slower or busier machine.
export const SCALE = Math.max(1, Number(process.env.QML_TEST_TIMEOUT_SCALE) || 1);

// Condition polling inside a TestCase (wait() keeps the event loop running). Timeouts are
// generous upper bounds, never the expected delay: a check passes as soon as it holds.
export const poll = `
  function check(condition, message) { if (!condition) throw Error(message || "check failed") }
  function until(condition, timeout, message) {
    var end = Date.now() + (timeout || 10000) * ${SCALE}
    while (!condition()) {
      if (Date.now() > end) throw Error("timed out: " + (message || condition))
      wait(20)
    }
  }
  // Clicks an item once a frame shows the current layout: a click right after the layout
  // changed (a label grew, a button swapped in) can miss under load.
  function press(item) { waitForRendering(item, 3000 * ${SCALE}); mouseClick(item) }
  // Retries checks that throw until they all hold; past the timeout, the last failure.
  function settle(checks, timeout) {
    var end = Date.now() + (timeout || 10000) * ${SCALE}
    for (;;) {
      try { return checks() } catch (e) { if (Date.now() > end) throw e; wait(20) }
    }
  }`;

// Only offscreen QML windows receive simulated test keys.
export async function qml(t, body, { timeout = 30000, files = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gentle-qml-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await symlink('/usr/share/omarchy/shell/Commons', join(dir, 'Commons'));
  await symlink('/usr/share/omarchy/shell/Ui', join(dir, 'Ui'));
  // Names may have folders (e.g. a cached file under omarchy-gentle-dot/cache/<id>/).
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content, { mode: 0o700 });
  }
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
  let timedOut = false;
  const limit = timeout * SCALE;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, limit);
  const code = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(timer);
  assert.ok(!timedOut, `the QML scene did not finish within ${limit} ms (QML_TEST_TIMEOUT_SCALE=${SCALE})\n${output}`);
  assert.equal(code, 0, output);
  assert.match(output, /QML_PASS/, output);
  assert.doesNotMatch(output, /QML_FAIL|TypeError|ReferenceError/, output);
  return output;
}
