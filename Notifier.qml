import QtQuick
import Quickshell
import Quickshell.Io

// Owned once by Client, never by a per-monitor widget. The native notification
// service supports libnotify's default action; each waiting sender is independent.
Item {
  id: root
  required property var client
  property string commandPath: "notify-send" // Replaced by a recorder in tests.
  // The Omarchy notification service plays no sound, so the plugin does.
  property string soundCommandPath: "pw-play" // Replaced by a recorder in tests.
  property string soundDir: "/usr/share/sounds/freedesktop/stereo/"
  // 1.5 s of silence played first: an idle output is suspended (WirePlumber, after 5 s) and
  // an HDMI monitor drops the first second or so when it wakes, which is the whole sound.
  readonly property string wakeClip: decodeURIComponent(String(Qt.resolvedUrl("assets/sounds/wake-silence.oga")).replace(/^file:\/\//, ""))
  // Omarchy keeps Do Not Disturb here (plugins/notifications/Service.qml, key "dnd").
  property string dndPath: (Quickshell.env("HOME") || "") + "/.local/state/omarchy/notifications.json"
  // Only the loud ones: most freedesktop sounds peak around -11 to -20 dB and are
  // inaudible on monitor speakers (complete peaks at -3 dB, message at -6 dB).
  readonly property var sounds: ({
    reply: "complete.oga",
    test: "complete.oga",
    ask: "message.oga",
    lost: "message.oga",
    reconnected: "complete.oga"
  })
  property string lastKind: ""
  property bool replaying: true
  property var completed: ({})
  property bool hadReady: false
  property bool outage: false
  property bool lostShown: false
  signal commandOutput(string line)
  signal soundOutput(string line)

  function plain(text) {
    return String(text || "")
      .replace(/```[^\n]*\n?/g, "").replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "")
      .replace(/^[ \t]*#{1,6}\s+/gm, "").replace(/^[ \t]*>\s?/gm, "")
      .replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim()
  }

  // The server supports markup: escape literal plain-text characters at the
  // transport boundary so assistant text cannot create links or formatting.
  function escaped(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }

  function notify(kind, title, body, force) {
    if (!client.notificationsEnabled || (!force && client.panelVisible)) return false
    var process = sender.createObject(root, { command: [commandPath,
      "--app-name=Gentle Dot", "--action=default=Open", "--wait", "--expire-time=8000",
      "--", plain(title), escaped(plain(body).slice(0, 140))] })
    if (!process) return false
    lastKind = kind
    process.running = true
    playSound(kind)
    return true
  }

  function doNotDisturb() {
    dndFile.reload()
    try { return JSON.parse(dndFile.text() || "{}").dnd === true } catch (e) { return false }
  }

  function playSound(kind) {
    if (!client.notificationSoundEnabled || !sounds[kind] || doNotDisturb()) return false
    var player = soundPlayer.createObject(root, { command: [soundCommandPath, wakeClip],
      next: [soundCommandPath, soundDir + sounds[kind]] })
    if (!player) return false
    player.running = true
    return true
  }

  function notifyTest() {
    return notify("test", "Gentle Dot", "Notifications are working. Click to open Gentle Dot.", true) ? "sent" : "disabled"
  }

  function handle(msg) {
    if (msg.type === "ready") replaying = true
    else if (msg.type === "history") {
      for (var i = 0; i < client.messages.count; i++) completed[client.messages.get(i).msgId] = true
      replaying = false
    } else if (msg.type === "message_done") {
      var id = String(msg.messageId || "")
      var duplicate = completed[id]
      completed[id] = true
      if (!replaying && !duplicate && !msg.error && !msg.stopped)
        notify("reply", "Gentle Dot", msg.text, false)
    }
  }

  function newAsk(ask) {
    if (!replaying) notify("ask", "Gentle Dot · " + (ask.title || "Needs you"), "The assistant needs you.", false)
  }

  function connectionChanged() {
    if (client.connected) {
      hadReady = true
      downTimer.stop()
      if (lostShown) notify("reconnected", "Gentle Dot", "Reconnected", false)
      outage = false
      lostShown = false
    } else if (hadReady && !outage && (client.connection === "reconnecting" || client.connection === "fatal")) {
      outage = true
      downTimer.restart()
    }
  }

  Timer {
    id: downTimer
    interval: 10001
    onTriggered: if (root.outage && !root.client.connected)
      root.lostShown = root.notify("lost", "Gentle Dot", "Connection lost. Check Gentle Dot or your network.", false)
  }

  Component {
    id: sender
    Process {
      stdout: SplitParser {
        onRead: function(line) {
          if (line.trim() === "default") root.client.openChat()
          else root.commandOutput(line)
        }
      }
      // notify-send --wait reports an expired notification on stderr; that is not an error.
      stderr: SplitParser { onRead: function(line) { if (line.indexOf("Wait timeout expired") < 0) console.warn("Gentle Dot notification:", line) } }
      onExited: function(code) {
        if (code !== 0) console.warn("Gentle Dot notification command exited:", code)
        var process = this
        Qt.callLater(function() { process.destroy() })
      }
    }
  }
  FileView {
    id: dndFile
    path: root.dndPath
    blockLoading: true
    printErrors: false
  }

  Component {
    id: soundPlayer
    Process {
      // The command to run once this one ends (the sound after the wake clip).
      property var next: null
      stdout: SplitParser { onRead: function(line) { root.soundOutput(line) } }
      onExited: function(code) {
        if (code !== 0) console.warn("Gentle Dot notification sound exited:", code)
        if (next) {
          var after = soundPlayer.createObject(root, { command: next })
          if (after) after.running = true
        }
        var process = this
        Qt.callLater(function() { process.destroy() })
      }
    }
  }

  Connections {
    target: root.client
    function onMessage(msg) { root.handle(msg) }
    function onConnectedChanged() { root.connectionChanged() }
    function onConnectionChanged() { root.connectionChanged() }
  }
}
