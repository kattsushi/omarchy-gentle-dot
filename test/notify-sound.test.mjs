import test from 'node:test';
import { poll, qml } from './composer-harness.test.mjs';

// The Omarchy notification service plays no sound, so the plugin does: one freedesktop sound
// per kind, skipped when the user turned sounds off or Omarchy's Do Not Disturb is on.
test('notification sounds: per kind, off switch, Do Not Disturb', async t => {
  await qml(t, `
  Plugin.Client {
    id: client
    property var notified: []
    property var played: []
    property int wakes: 0
    property var saved: null
    shell: QtObject {
      function updateEntryInline(id, settings) { client.saved = settings; return true }
      function summon(id, payload) {}
    }
    function send(obj) { return true }
    notifier.commandPath: Qt.resolvedUrl("record").toString().replace("file://", "")
    notifier.soundCommandPath: Qt.resolvedUrl("record-sound").toString().replace("file://", "")
    notifier.dndPath: Qt.resolvedUrl("missing.json").toString().replace("file://", "")
    Connections {
      target: client.notifier
      function onCommandOutput(line) { client.notified = client.notified.concat([JSON.parse(line)]) }
      // Each sound is preceded by a silent clip that wakes a suspended output (HDMI drops the first ~1.5 s).
      function onSoundOutput(line) {
        var args = JSON.parse(line)
        if (String(args[args.length - 1]).indexOf("wake-silence.oga") >= 0) client.wakes++
        else client.played = client.played.concat([args])
      }
    }
  }
  TestCase {
    id: checks; when: false
    function frame(msg) { client.handleLine(JSON.stringify(msg)) }
    function reply(id) { frame({type: "message_done", messageId: id, text: "Done"}) }
    ${poll}
    // Notifications and sounds are recorder processes (a sound starts once its wake clip ends):
    // wait until that many have reported, then a little longer so that an extra one would show
    // up too. Every later count is exact, so a stray one fails the next one at the latest.
    function counts(n, s) {
      var reached = function() { return client.notified.length >= n && client.played.length >= s && client.wakes >= s }
      var wrong = function() {
        return Error("expected " + n + " notifications and " + s + " sounds after as many wake clips, got "
          + client.notified.length + ", " + client.played.length + " and " + client.wakes)
      }
      try { until(reached) } catch (e) { throw wrong() }
      wait(200)
      if (client.notified.length !== n || client.played.length !== s || client.wakes !== s) throw wrong()
    }
    function sound(i) { var args = client.played[i]; return String(args[args.length - 1]).split("/").pop() }
    function run() {
      try {
        compare(client.notificationSoundEnabled, true)
        frame({type: "bridge", state: "open"}); frame({type: "ready"}); frame({type: "history", messages: []})
        reply("r1")
        counts(1, 1)
        compare(sound(0), "complete.oga")
        frame({type: "ask", ask: {requestId: "a1", title: "Approve", method: "confirm"}})
        counts(2, 2)
        compare(sound(1), "message.oga")
        compare(client.notifier.notifyTest(), "sent")
        counts(3, 3)
        compare(sound(2), "complete.oga")

        // Visible panel: no notification, so no sound either.
        client.reportPanelVisibility(checks, true)
        reply("r2")
        counts(3, 3)
        client.reportPanelVisibility(checks, false)

        // Do Not Disturb in ~/.local/state/omarchy/notifications.json silences the sound only.
        client.notifier.dndPath = Qt.resolvedUrl("dnd.json").toString().replace("file://", "")
        reply("r3")
        counts(4, 3)
        client.notifier.dndPath = Qt.resolvedUrl("missing.json").toString().replace("file://", "")

        // The switch persists with the other settings and silences the sound only.
        client.entrySettings = {serverUrl: "wss://mac.example/ws", tokenFile: "unchanged", notifications: true}
        client.configured = true; client.nodePath = "node"; client.serverUrl = "wss://mac.example/ws"; client.tokenFile = "unchanged"
        verify(client.saveNotificationSound(false))
        compare(client.saved.notificationSound, false)
        compare(client.saved.notifications, true)
        compare(client.saved.serverUrl, "wss://mac.example/ws")
        compare(client.saved.tokenFile, "unchanged")
        compare(client.notificationSoundEnabled, false)
        reply("r4")
        counts(5, 3)
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 1; running: true; onTriggered: checks.run() }
  `, {
    timeout: 60000,
    files: {
      record: '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n',
      'record-sound': '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n',
      'dnd.json': '{"dnd": true}\n',
    },
  });
});
