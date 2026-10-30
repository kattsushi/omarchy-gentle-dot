import test from 'node:test';
import { poll, qml } from './composer-harness.test.mjs';

test('notifications: hidden/visible replies, replay, asks, outages, disable, persistence and click', async t => {
  await qml(t, `
  Plugin.Client {
    id: client
    property var recorded: []
    property var saved: null
    property int opened: 0
    shell: QtObject {
      function updateEntryInline(id, settings) { client.saved = settings; return true }
      function summon(id, payload) { client.opened++ }
    }
    function send(obj) { return true }
    notifier.notifyCommand: [Qt.resolvedUrl("record").toString().replace("file://", "")]
    Connections {
      target: client.notifier
      function onCommandOutput(line) { client.recorded = client.recorded.concat([JSON.parse(line)]) }
    }
  }
  TestCase {
    id: checks; when: false
    function frame(msg) { client.handleLine(JSON.stringify({from: msg.type === "bridge" ? "bridge" : "daemon", msg: msg})) }
    // Nothing on a notification's command line (S22.2): its text arrives on stdin.
    function shown(i) {
      var note = client.recorded[i]
      if (note.argv.length !== 0) throw Error("arguments on the notification command line: " + JSON.stringify(note.argv))
      compare(note.payload.appName, "Gentle Dot")
      compare(JSON.stringify(note.payload.actions), JSON.stringify(["default", "Open"]))
      compare(note.payload.expireMs, 8000)
      return note.payload
    }
    function reply(id, extra) { frame(Object.assign({type: "message_done", messageId: id, text: "**Hello** [world](https://example.org)\\n" + "x".repeat(180)}, extra || {})) }
    ${poll}
    // Each notification is a recorder process: wait until n have reported, then a little longer
    // so that an extra one would show up too. Every later count is exact, so a stray
    // notification fails the next one at the latest.
    function count(n) {
      var wrong = function() { return Error("notification count: expected " + n + ", got " + client.recorded.length + "; last=" + client.notifier.lastKind + "; outage=" + client.notifier.outage + "; ready=" + client.notifier.hadReady) }
      try { until(function() { return client.recorded.length >= n }) } catch (e) { throw wrong() }
      wait(150)
      if (client.recorded.length !== n) throw wrong()
    }
    function run() {
      try {
        compare(client.notificationsEnabled, true)
        frame({type: "bridge", state: "open"}); frame({type: "ready"})
        // Pending asks replay before history and must not trigger notifications.
        frame({type: "ask", ask: {requestId: "replay", title: "Old question", method: "confirm"}})
        frame({type: "history", messages: [{id: "old", role: "assistant", text: "old reply"}]})
        reply("old")
        count(0)
        reply("fresh")
        count(1)
        compare(shown(0).summary, "Gentle Dot")
        compare(shown(0).body, "Hello world " + "x".repeat(128))
        compare(client.opened, 1)
        reply("fresh"); reply("stopped", {stopped: true}); reply("error", {error: "oops"})
        count(1)
        client.reportPanelVisibility(checks, true)
        reply("visible")
        count(1)
        client.reportPanelVisibility(checks, false)
        reply("visible")
        count(1)
        frame({type: "ask", ask: {requestId: "new", title: "Approve command", method: "confirm"}})
        count(2)
        compare(shown(1).summary, "Gentle Dot · Approve command")
        frame({type: "ask", ask: {requestId: "new", title: "Approve command", method: "confirm"}})
        count(2)
        frame({type: "bridge", state: "reconnecting"})
        wait(100)
        frame({type: "bridge", state: "open"}); frame({type: "ready"}); frame({type: "history", messages: []})
        count(2)
        frame({type: "bridge", state: "fatal"})
        longWait.start()
      } catch (e) { console.log("QML_FAIL: " + e); Qt.quit() }
    }
    function afterOutage() {
      try {
        count(3)
        if (client.notifier.lastKind !== "lost") throw Error("expected lost, got " + client.notifier.lastKind)
        frame({type: "bridge", state: "reconnecting"})
        wait(100)
        count(3)
        frame({type: "bridge", state: "open"}); frame({type: "ready"}); frame({type: "history", messages: []})
        count(4)
        compare(shown(3).body, "Reconnected")
        // The real command is the bridge's D-Bus helper, run by Node with no other argument.
        var helper = client.notifier.defaultCommand
        compare(helper.length, 2)
        verify(helper[1].slice(-"/bridge/notify.mjs".length) === "/bridge/notify.mjs", helper[1])
        client.entrySettings = {serverUrl: "wss://mac.example/ws", tokenFile: "unchanged", notifications: true}
        // Keep configure from starting the real bridge; the same URL/config is already set.
        client.configured = true; client.nodePath = "node"; client.serverUrl = "wss://mac.example/ws"; client.tokenFile = "unchanged"
        verify(client.saveNotifications(false))
        compare(client.saved.notifications, false)
        compare(client.saved.serverUrl, "wss://mac.example/ws")
        compare(client.saved.tokenFile, "unchanged")
        reply("disabled")
        frame({type: "ask", ask: {requestId: "disabled", title: "No toast", method: "confirm"}})
        compare(client.notifier.notifyTest(), "disabled")
        frame({type: "bridge", state: "reconnecting"})
        disabledWait.start()
      } catch (e) { console.log("QML_FAIL: " + e); Qt.quit() }
    }
    function afterDisabled() {
      try {
        frame({type: "bridge", state: "open"}); frame({type: "ready"})
        count(4)
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 1; running: true; onTriggered: checks.run() }
  Timer { id: longWait; interval: 10300; onTriggered: checks.afterOutage() }
  Timer { id: disabledWait; interval: 10300; onTriggered: checks.afterDisabled() }
  `, { timeout: 60000, files: { record: `#!/usr/bin/env node
// Reports its arguments and the one-line JSON payload from stdin, then "clicks" the notification.
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (!input.includes('\\n')) return;
  console.log(JSON.stringify({ argv: process.argv.slice(2), payload: JSON.parse(input.slice(0, input.indexOf('\\n'))) }));
  console.log('default');
  process.exit(0);
});
` } });
});
