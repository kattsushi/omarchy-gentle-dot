import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { poll, qml } from './composer-harness.test.mjs';

const NODE_MESSAGE = 'Gentle Dot needs Node.js 22 or newer. Install it (e.g. `omarchy pkg add nodejs` or mise) and reopen the panel.';

// Fake `node` commands. Each logs how it was called; anything but --version stands in for the
// bridge and stops at once with a fatal line, so no daemon or network is involved.
const bridgeLine = '{"from":"bridge","msg":{"type":"bridge","state":"fatal","reason":"bad_url","message":"fake bridge ran"}}';
const fake = version => `#!/bin/sh
echo "$*" >> "$(dirname "$0")/calls-$(basename "$0").log"
if [ "$1" = --version ]; then ${version}; exit 0; fi
echo '${bridgeLine}'
exit 2
`;
const files = {
  'node-old': fake('echo v20.11.1'),
  'node-ok': fake('echo v22.3.0'),
  'node-127': '#!/bin/sh\nexit 127\n',
  // Passes the version check, then the bridge cannot run (a shim whose Node went away).
  'node-gone': '#!/bin/sh\nif [ "$1" = --version ]; then echo v24.1.0; exit 0; fi\nexit 127\n',
  // Too old on the first check, upgraded before Retry.
  'node-upgraded': `#!/bin/sh
d=$(dirname "$0")
if [ "$1" = --version ]; then
  if [ -e "$d/upgraded" ]; then echo v22.1.0; else touch "$d/upgraded"; echo v18.19.0; fi
  exit 0
fi
echo '${bridgeLine}'
exit 2
`
};

test('a missing or too-old Node stops the panel with what to install, and Retry checks again', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications: false}) }
  // Every start goes through "connecting", so a new failure is told apart from the last one.
  Connections { target: client; function onConnectionChanged() { if (client.connection === "connecting") checks.starts++ } }
  TestCase {
    id: checks; when: false
    property int starts: 0
    property int before: 0
    function eq(actual, expected, what) { if (actual !== expected) throw Error((what || "") + " expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)) }
    ${poll}
    function path(name) { return String(Qt.resolvedUrl(name)).replace(/^file:\\/\\//, "") }
    function connect(name) {
      before = starts
      client.configure({nodePath: name.indexOf("/") === 0 ? name : path(name), serverUrl: "ws://127.0.0.1:9/ws", tokenFile: "/nonexistent/token", notifications: false})
    }
    function fatal(reason, message, what) {
      until(function() { return starts > before && client.connection === "fatal" }, 10000, what + ": never fatal")
      eq(client.fatalReason, reason, what)
      eq(client.fatalMessage, message, what)
    }
    function run() {
      try {
        eq(client.nodeMessage, ${JSON.stringify(NODE_MESSAGE)})
        connect("/nonexistent/bin/node")
        fatal("node_missing", client.nodeMessage, "not found")
        connect("node-127")
        fatal("node_missing", client.nodeMessage, "exit 127")
        connect("node-old")
        fatal("node_too_old", client.nodeMessage, "v20")
        connect("node-ok")
        fatal("bad_url", "fake bridge ran", "v22 runs the bridge")
        connect("node-gone")
        fatal("node_missing", client.nodeMessage, "bridge exit 127")
        connect("node-upgraded")
        fatal("node_too_old", client.nodeMessage, "v18")
        // The panel's Retry button calls restart(): Node is checked again, not remembered as bad.
        before = starts
        client.restart()
        fatal("bad_url", "fake bridge ran", "after upgrade")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 50; running: true; onTriggered: checks.run() }
  `, { files, timeout: 30000 });
});

test('the fatal view shows the message with a Retry that restarts the client', async () => {
  const panel = await readFile(new URL('../Panel.qml', import.meta.url), 'utf8');
  const fatal = panel.slice(panel.indexOf('visible: !root.settingsOpen && root.fatal'));
  assert.match(fatal, /^[\s\S]*?root\.client\.displayText\(root\.client\.fatalMessage\)[\s\S]*?text: "Retry"[\s\S]*?onClicked: root\.client\.restart\(\)/);
});
