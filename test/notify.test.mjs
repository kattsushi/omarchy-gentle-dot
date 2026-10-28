import test from 'node:test';
import { qml } from './composer-harness.test.mjs';

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
    notifier.commandPath: Qt.resolvedUrl("record").toString().replace("file://", "")
    Connections {
      target: client.notifier
      function onCommandOutput(line) { client.recorded = client.recorded.concat([JSON.parse(line)]) }
    }
  }
  TestCase {
    id: checks; when: false
    function frame(msg) { client.handleLine(JSON.stringify(msg)) }
    function reply(id, extra) { frame(Object.assign({type: "message_done", messageId: id, text: "**Hello** [world](https://example.org)\\n" + "x".repeat(180)}, extra || {})) }
    function count(n) { wait(150); if (client.recorded.length !== n) throw Error("notification count: expected " + n + ", got " + client.recorded.length + "; last=" + client.notifier.lastKind + "; outage=" + client.notifier.outage + "; ready=" + client.notifier.hadReady) }
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
        var args = client.recorded[0]
        compare(args[args.length - 2], "Gentle Dot")
        compare(args[args.length - 1], "Hello world " + "x".repeat(128))
        verify(args.indexOf("--action=default=Open") >= 0)
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
        compare(client.recorded[1][client.recorded[1].length - 2], "Gentle Dot · Approve command")
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
        compare(client.recorded[3][client.recorded[3].length - 1], "Reconnected")
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
  `, { timeout: 30000, files: { record: '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2))); console.log("default");\n' } });
});
