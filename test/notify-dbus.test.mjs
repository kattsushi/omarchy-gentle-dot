import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeMessage, openBus, splitSignature } from '../bridge/dbus.mjs';

// S22.2: bridge/notify.mjs shows a notification through org.freedesktop.Notifications on the
// session bus, its text read from stdin; it never appears in a command line. These tests run a
// private dbus-daemon (no service activation, so no real notification daemon starts) and a fake
// notification service on it.

const HELPER = fileURLToPath(new URL('../bridge/notify.mjs', import.meta.url));
let dbusDaemon = '';
try { dbusDaemon = execFileSync('sh', ['-c', 'command -v dbus-daemon'], { encoding: 'utf8' }).trim(); } catch { dbusDaemon = ''; }

let dir;
let busProcess;
let address;

before(async () => {
  if (!dbusDaemon) return;
  dir = await mkdtemp(join(tmpdir(), 'gd-notify-bus-'));
  await writeFile(join(dir, 'bus.conf'), `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=${join(dir, 'bus')}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`);
  busProcess = spawn(dbusDaemon, [`--config-file=${join(dir, 'bus.conf')}`, '--nofork', '--print-address'], { stdio: ['ignore', 'pipe', 'inherit'] });
  address = await new Promise((resolve, reject) => {
    let out = '';
    busProcess.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('\n')) resolve(out.trim());
    });
    busProcess.once('exit', (code) => reject(new Error(`dbus-daemon exited ${code}`)));
  });
});

after(async () => {
  busProcess?.kill();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const PATH = '/org/freedesktop/Notifications';
const IFACE = 'org.freedesktop.Notifications';

// A fake notification service: records Notify calls and answers them with `id`.
async function fakeService(id) {
  const bus = await openBus(address);
  const [owned] = await bus.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus',
    member: 'RequestName', signature: 'su', body: [IFACE, 4] });
  assert.equal(owned, 1);
  const calls = [];
  let notified;
  const shown = new Promise((resolve) => { notified = resolve; });
  bus.on('message', (message) => {
    if (message.type !== 1 || message.member !== 'Notify' || message.interface !== IFACE) return;
    calls.push(message.body);
    bus.send({ type: 2, replySerial: message.serial, destination: message.sender, signature: 'u', body: [id] });
    notified(message.sender);
  });
  const signal = (member, signature, body, from = bus) => from.send({ type: 4, path: PATH, interface: IFACE, member, signature, body });
  return { bus, calls, shown, signal, close: () => bus.close() };
}

function runHelper(payload) {
  const child = spawn(process.execPath, [HELPER], { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify(payload)}\n`);
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

const payload = (extra = {}) => ({ appName: 'Gentle Dot', summary: 'Gentle Dot · Approve rm -rf private-dir',
  body: 'Private reply text &amp; more', actions: ['default', 'Open'], expireMs: 8000, ...extra });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Notify carries the text from stdin; the command line has none; a click from the service prints "default"', { skip: !dbusDaemon && 'dbus-daemon not installed' }, async (t) => {
  const service = await fakeService(42);
  t.after(service.close);
  const helper = runHelper(payload());
  t.after(() => helper.child.kill());
  await service.shown;
  assert.deepEqual(service.calls, [['Gentle Dot', 0, '', 'Gentle Dot · Approve rm -rf private-dir', 'Private reply text &amp; more',
    ['default', 'Open'], [], 8000]]);
  // What another local account could read while the notification is shown.
  const cmdline = await readFile(`/proc/${helper.child.pid}/cmdline`, 'utf8');
  assert.deepEqual(cmdline.split('\0').filter(Boolean), [process.execPath, HELPER]);
  // Another notification's click, and a click forged by a client that is not the service, are ignored.
  service.signal('ActionInvoked', 'us', [41, 'default']);
  const impostor = await openBus(address);
  t.after(() => impostor.close());
  service.signal('ActionInvoked', 'us', [42, 'default'], impostor);
  await sleep(300);
  assert.equal(helper.stdout(), '');
  assert.equal(helper.child.exitCode, null);
  service.signal('ActionInvoked', 'us', [42, 'default']);
  assert.equal(await helper.exited, 0);
  assert.equal(helper.stdout(), 'default\n');
  assert.equal(helper.stderr(), '');
});

test('the helper exits quietly when its notification closes, or when it expires', { skip: !dbusDaemon && 'dbus-daemon not installed' }, async (t) => {
  const service = await fakeService(7);
  t.after(service.close);
  const closed = runHelper(payload());
  t.after(() => closed.child.kill());
  await service.shown;
  service.signal('NotificationClosed', 'uu', [7, 2]);
  assert.equal(await closed.exited, 0);
  assert.equal(closed.stdout(), '');

  const expired = runHelper(payload({ expireMs: 200 }));
  t.after(() => expired.child.kill());
  const started = Date.now();
  assert.equal(await expired.exited, 0);
  assert.ok(Date.now() - started < 5000);
  assert.equal(expired.stdout(), '');
  assert.equal(expired.stderr(), '');
});

test('without a notification service the helper fails without echoing the text', { skip: !dbusDaemon && 'dbus-daemon not installed' }, async () => {
  const helper = runHelper(payload());
  assert.equal(await helper.exited, 1);
  assert.equal(helper.stdout(), '');
  assert.match(helper.stderr(), /ServiceUnknown|no notification service/i);
  assert.doesNotMatch(helper.stderr(), /private/i);
});

test('a bad payload is refused before anything is sent', { skip: !dbusDaemon && 'dbus-daemon not installed' }, async () => {
  const child = spawn(process.execPath, [HELPER], { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end('not json\n');
  assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 1);
  assert.match(stderr, /payload/);
});

// Nits: an empty struct or dict entry is no D-Bus type (and "a()" would loop forever), a dict entry
// has exactly a key and a value.
test('signatures: empty structs, empty or odd dict entries and unclosed types are refused, never looped on', () => {
  assert.deepEqual(splitSignature('susssasa{sv}i'), ['s', 'u', 's', 's', 's', 'as', 'a{sv}', 'i']);
  assert.deepEqual(splitSignature('a(yv)(i(s))'), ['a(yv)', '(i(s))']);
  for (const bad of ['()', 'a()', '{}', 'a{}', 'a{s}', 'a{svv}', '(s', 'a', 'z', '{sv}', 'a{vs}'])
    assert.throws(() => splitSignature(bad), /bad signature/, bad);
  assert.throws(() => encodeMessage({ type: 1, serial: 1, path: '/', member: 'X', signature: 'a()', body: [[[]]] }), /bad signature/);
});

test('a flood of signals before Notify answers is bounded and never mistaken for the click', { skip: !dbusDaemon && 'dbus-daemon not installed' }, async (t) => {
  const bus = await openBus(address);
  t.after(() => bus.close());
  await bus.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus',
    member: 'RequestName', signature: 'su', body: [IFACE, 4] });
  let helperName;
  const asked = new Promise((resolve) => bus.on('message', (message) => {
    if (message.type !== 1 || message.member !== 'Notify') return;
    helperName = message.sender;
    resolve(message);
  }));
  const helper = runHelper(payload());
  t.after(() => helper.child.kill());
  const call = await asked;
  for (let i = 0; i < 2000; i++) bus.send({ type: 4, path: PATH, interface: IFACE, member: 'ActionInvoked', signature: 'us', body: [i % 2 ? 5 : 9, 'default'] });
  bus.send({ type: 2, replySerial: call.serial, destination: helperName, signature: 'u', body: [5] });
  await sleep(300);
  // Early signals for id 5 arrived before the id was known: none of them counts as a click.
  assert.equal(helper.stdout(), '');
  bus.send({ type: 4, path: PATH, interface: IFACE, member: 'ActionInvoked', signature: 'us', body: [5, 'default'] });
  assert.equal(await helper.exited, 0);
  assert.equal(helper.stdout(), 'default\n');
});
