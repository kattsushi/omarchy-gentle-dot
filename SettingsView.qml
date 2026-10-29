import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui
import "privacy.mjs" as Privacy

FocusScope {
  id: root
  required property var client
  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property string fontFamily: Style.font.family
  // While connection details are hidden the host, port and custom URL fields are read-only
  // copies that show the mask; the real fields (and typing into them) come back with the eye.
  readonly property bool masked: !client || client.privacyMasked
  readonly property Item focusTarget: masked ? hostMask : hostField
  property bool remoteMode: false
  property bool https: true
  property bool advanced: false
  property bool working: false
  property string feedback: ""
  // The URL of the last test started from this view, so "Use this connection" applies exactly that one.
  property string testedUrl: ""
  property bool failed: false
  // Keyboard shortcut (S19.3): detected from `hyprctl binds -j`, never written by the plugin.
  property string hyprctlCommand: "hyprctl"
  property string clipboardCommand: "wl-copy"
  readonly property string shortcutSnippet: decodeURIComponent(String(Qt.resolvedUrl("hypr/gentle-dot.lua")).replace(/^file:\/\//, ""))
  property string shortcutState: "checking"   // checking | found | missing | unknown
  property string shortcutKeys: "SUPER + ALT + D"
  property string shortcutFeedback: ""
  property bool shortcutFailed: false
  readonly property string host: hostField.text.trim()
  readonly property string port: portField.text.trim()
  readonly property string candidateUrl: !remoteMode ? client.localUrl : advanced ? customField.text.trim()
    : buildUrl(https, host, port)
  readonly property string candidateTokenPath: !remoteMode ? client.localTokenFile
    : client.remoteTokenFile(advanced ? client.hostOf(candidateUrl) : host)
  readonly property string validation: !remoteMode ? "" : advanced
    ? (/^wss?:\/\/[^\s/?#]+(?:\/[^\s]*)?$/.test(candidateUrl) ? "" : "Custom URL must start with ws:// or wss:// and include a host.")
    : (!host || /[\s/?#]/.test(host) ? "Enter an IP address or DNS name (without a scheme)."
      : (port !== "" || !https) && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
        ? (https ? "HTTPS port must be between 1 and 65535, or empty for 443." : "Port must be between 1 and 65535.") : "")

  // HTTPS (tailscale serve) omits the port when it is empty or 443; Direct always carries it.
  function buildUrl(secure, hostName, portText) {
    var authority = hostName.indexOf(":") >= 0 && hostName[0] !== "[" ? "[" + hostName + "]" : hostName
    if (secure) return "wss://" + authority + (portText === "" || portText === "443" ? "" : ":" + portText) + "/ws"
    return "ws://" + authority + ":" + portText + "/ws"
  }

  function load() {
    if (!client) return
    remoteMode = client.remote
    hostField.text = client.remote ? client.host : ""
    https = client.serverUrl.indexOf("wss://") === 0 || !client.remote
    var match = client.serverUrl.match(/:(\d+)\/ws$/)
    portField.text = match ? match[1] : (https ? "" : "4317")
    customField.text = client.remote ? client.serverUrl : ""
    var generated = buildUrl(https, host, portField.text.trim())
    advanced = client.remote && generated !== client.serverUrl
    tokenField.text = ""
    feedback = ""
  }

  function result(text, error) { feedback = text; failed = error }

  // A bind toggles this panel when it runs the toggle command (hyprlang exec) or, for Lua binds
  // that hyprctl shows only as "__lua", carries the description hypr/gentle-dot.lua gives it.
  function shortcutFrom(json) {
    var binds
    try { binds = JSON.parse(json) } catch (e) { return {state: "unknown", keys: "SUPER + ALT + D"} }
    if (!Array.isArray(binds)) return {state: "unknown", keys: "SUPER + ALT + D"}
    for (var i = 0; i < binds.length; i++) {
      var bind = binds[i] || {}
      if (bind.description === "Gentle Dot" || /omarchy-shell\s+shell\s+toggle\s+omarchy-gentle-dot\b/.test(String(bind.arg || ""))) {
        var mods = []
        var names = [[64, "SUPER"], [4, "CTRL"], [8, "ALT"], [1, "SHIFT"]]
        for (var j = 0; j < names.length; j++) if (bind.modmask & names[j][0]) mods.push(names[j][1])
        return {state: "found", keys: mods.concat([String(bind.key || "").toUpperCase()]).join(" + ")}
      }
    }
    return {state: "missing", keys: "SUPER + ALT + D"}
  }

  function checkShortcut() {
    if (shortcutProbe.running) return
    shortcutProbe.launched = false
    shortcutProbe.command = [hyprctlCommand, "binds", "-j"]
    shortcutProbe.running = true
  }

  function shortcutChecked(exitCode, text) {
    var found = exitCode === 0 ? shortcutFrom(text) : {state: "unknown", keys: "SUPER + ALT + D"}
    shortcutState = found.state
    shortcutKeys = found.keys
  }

  // The snippet file (which starts with its one-line instruction) to the clipboard.
  function copyShortcut() {
    if (shortcutCopy.running) return
    shortcutFeedback = ""
    shortcutFailed = false
    shortcutCopy.launched = false
    shortcutCopy.command = ["sh", "-c", "\"$1\" < \"$2\"", "sh", clipboardCommand, shortcutSnippet]
    shortcutCopy.running = true
  }

  function shortcutCopied(ok) {
    shortcutFailed = !ok
    shortcutFeedback = ok ? 'Copied. Save it as ~/.config/hypr/gentle-dot.lua and add require("hypr.gentle-dot") to ~/.config/hypr/hyprland.lua.'
      : "Could not copy: install wl-clipboard, or copy " + shortcutSnippet + " by hand."
  }

  Process {
    id: shortcutProbe
    property bool launched: false
    property string output: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: shortcutProbe.output = text
    }
    onStarted: { launched = true; output = "" }
    // No exited() when hyprctl cannot start (not on Hyprland).
    onRunningChanged: if (!running && !launched) root.shortcutChecked(127, "")
    onExited: function(exitCode) { Qt.callLater(function() { root.shortcutChecked(exitCode, shortcutProbe.output) }) }
  }

  Process {
    id: shortcutCopy
    property bool launched: false
    onStarted: launched = true
    onRunningChanged: if (!running && !launched) root.shortcutCopied(false)
    onExited: function(exitCode) { root.shortcutCopied(exitCode === 0) }
  }

  // A message as shown: masked with the service's known names plus the host being edited.
  function shown(text) {
    if (!masked) return text
    return Privacy.maskText(text, client.sensitiveTerms.concat([host, client.hostOf(customField.text)]))
  }

  // Capture the candidate before asynchronous IO, and disable edits until done.
  // ws(s)://host[:port]/ws -> http(s)://host[:port]/health (the daemon answers it without a token).
  function healthUrlOf(url) {
    var match = String(url || "").match(/^(wss?):\/\/([^\/?#]+)/)
    return match ? (match[1] === "wss" ? "https" : "http") + "://" + match[2] + "/health" : ""
  }

  // Explains a failed /health probe from curl's exit code and the HTTP status.
  function healthProblem(exitCode, status, url) {
    var where = client.hostOf(url) || url
    var macHint = " On that machine: open Gentle Dot and run `tailscale serve --bg 4317`."
    if (exitCode === 6) return "Cannot resolve " + where + ". Check the host name (and that MagicDNS is on)."
    if (exitCode === 7) return "Nothing is listening at " + where + "." + macHint
    if (exitCode === 28) return "No answer from " + where + " within 5 s." + macHint
    if (exitCode === 35 || exitCode === 60) return "HTTPS failed at " + where + ": is `tailscale serve` set up there?"
    if (exitCode !== 0) return "Cannot reach " + where + " (curl exit " + exitCode + ")."
    if (status !== "200") return where + " answered HTTP " + status + " on /health: it does not look like a Gentle Dot daemon."
    return ""
  }

  function apply(testOnly) {
    if (working || validation) { result(validation, true); return }
    var url = candidateUrl
    var path = candidateTokenPath
    working = true
    function proceed(ok) {
      working = false
      if (!ok) {
        result(testOnly ? "Reachable at " + client.hostOf(url) + ". Paste its token (pbcopy < ~/.gentle-dot/token on that machine) to finish the test."
          : "Paste the remote token first, or check its saved file.", !testOnly)
        return
      }
      tokenField.text = ""
      if (testOnly) {
        result("", false)
        if (client.testConnection(url, path)) testedUrl = url
        else result("A connection test is already running.", true)
      } else {
        var saved = client.saveConnection(url, path)
        result(saved ? "Saved, reconnecting…" : "Could not save the connection.", !saved)
      }
    }
    function checkToken() {
      if (!remoteMode) proceed(true)
      else if (tokenField.text.trim()) client.writeToken(path, tokenField.text, proceed)
      else client.tokenFileExists(path, proceed)
    }
    if (!testOnly || !remoteMode) { checkToken(); return }
    // Remote test: first prove something answers, so the message says what is wrong.
    result("Checking " + healthUrlOf(url) + "…", false)
    healthProbe.callback = function(exitCode, status) {
      var problem = healthProblem(exitCode, status, url)
      if (problem) { working = false; result(problem, true) }
      else checkToken()
    }
    healthProbe.command = ["curl", "-sS", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", healthUrlOf(url)]
    healthProbe.running = true
  }

  Process {
    id: healthProbe
    property var callback: null
    property string status: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: healthProbe.status = text.trim()
    }
    onExited: function(exitCode) {
      var done = callback
      callback = null
      // Let stdout settle before reading the status code.
      Qt.callLater(function() { if (done) done(exitCode, healthProbe.status) })
    }
  }

  onVisibleChanged: {
    if (visible) {
      load()
      checkShortcut()
      shortcutFeedback = ""
      if (client.settingsSection === "voice") {
        flick.contentY = 0
        client.settingsSection = ""
      }
    }
    else tokenField.text = ""
  }
  Component.onCompleted: {
    load()
    checkShortcut()
  }
  Keys.onEscapePressed: function(event) {
    if (client.voice.active) client.voice.cancel()
    else client.view = "chat"
    event.accepted = true
  }

  component Label: Text {
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.Wrap
    textFormat: Text.PlainText
  }
  component Field: TextField {
    width: parent.width
    foreground: root.foreground
    font.family: root.fontFamily
    onTextEdited: { root.remoteMode = true; root.feedback = "" }
  }
  // Stands in for a Field while masked: read-only, so selecting or copying yields only the mask.
  component MaskField: TextField {
    width: parent.width
    foreground: root.foreground
    font.family: root.fontFamily
    readOnly: true
  }

  Flickable {
    id: flick
    anchors.fill: parent
    contentWidth: width
    contentHeight: form.height
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: form
      width: parent.width
      spacing: Style.space(8)
      enabled: !root.working

      Label { text: "Notifications"; font.bold: true }
      Button {
        text: (root.client.notificationsEnabled ? "● " : "○ ") + "Desktop notifications"
        bordered: true
        onClicked: if (!root.client.saveNotifications(!root.client.notificationsEnabled)) root.result("Could not save the notification preference.", true)
      }
      Label { width: parent.width; text: "Replies, questions and connection outages while the panel is hidden. Click a notification to open the chat." }
      Button {
        text: (root.client.notificationSoundEnabled ? "● " : "○ ") + "Notification sound"
        bordered: true
        enabled: root.client.notificationsEnabled
        onClicked: if (!root.client.saveNotificationSound(!root.client.notificationSoundEnabled)) root.result("Could not save the sound preference.", true)
      }
      Label { width: parent.width; text: "A system sound for each notification. Omarchy's Do Not Disturb silences it." }
      Label { text: "Appearance"; font.bold: true }
      Row {
        spacing: Style.space(8)
        Repeater {
          model: [1, 0.95, 0.9, 0.85, 0.8]
          Button {
            required property real modelData
            text: (Math.abs(root.client.panelOpacity - modelData) < 0.001 ? "● " : "") + Math.round(modelData * 100) + "%"
            bordered: true
            onClicked: if (!root.client.savePanelOpacity(modelData)) root.result("Could not save the panel opacity.", true)
          }
        }
      }
      Label { width: parent.width; text: "Panel background opacity, like a terminal's background-opacity. Text and bubbles stay opaque." }
      Row {
        spacing: Style.space(8)
        Label { anchors.verticalCenter: parent.verticalCenter; text: "Avatar sleeps after" }
        Repeater {
          model: [0, 15, 30, 60]
          Button {
            required property int modelData
            objectName: "avatarSleep" + modelData
            text: (root.client.avatarSleepMinutes === modelData ? "● " : "") + (modelData ? modelData + " min" : "Off")
            bordered: true
            onClicked: if (!root.client.saveAvatarSleepMinutes(modelData)) root.result("Could not save the avatar sleep time.", true)
          }
        }
      }
      Label { width: parent.width; text: "Without activity for this long, the avatar dozes off; any activity wakes it. Off keeps it awake." }
      Label { text: "Voice"; font.bold: true }
      Label {
        width: parent.width
        text: "Speech runtime (sherpa-onnx-node 2.0.1) · " + ({installed: "installed", missing: "not installed"}[root.client.voice.runtimeState]
          || "checking") + (root.client.voice.runtimeState === "installed" && root.client.voice.runtimeSource === "plugin" ? " (plugin node_modules)" : "")
      }
      Label {
        width: parent.width
        text: "Parakeet v3 · " + root.client.voice.modelState + (root.client.voice.modelBusy
          ? " · " + (root.client.voice.received / 1000000).toFixed(1) + " / 487.2 MB" : "")
      }
      Label {
        width: parent.width
        text: "Recorder · " + (root.client.voice.recorderState === "found" ? root.client.voice.recorder
          : root.client.voice.recorderState === "missing" ? "missing. " + root.client.voice.recorderMessage : "checking")
        color: root.client.voice.recorderState === "missing" ? root.urgent : root.foreground
      }
      Label {
        width: parent.width
        text: root.client.voice.ready ? "Voice is ready." : "Private, on-device dictation; only text is sent. Enable voice installs the speech runtime"
          + " (about 35 MB) in ~/.local/share/omarchy-gentle-dot and downloads the model (487 MB, ~640 MiB extracted)."
      }
      Label {
        width: parent.width
        visible: root.client.voice.modelState === "damaged"
        text: "The model files are damaged" + (root.client.voice.damagedFiles.length ? " (" + root.client.voice.damagedFiles.join(", ") + ")" : "")
          + ". Download again replaces them."
        color: root.urgent
      }
      Label {
        width: parent.width
        visible: root.client.voice.setupBusy && text !== ""
        text: {
          var voice = root.client.voice
          if (voice.setupStep === "runtime") return "Installing the speech runtime…"
          if (voice.setupStep === "model") return voice.modelState === "verifying" ? "Verifying the model…"
            : "Downloading the model… " + (voice.received / 1000000).toFixed(1) + " / 487.2 MB"
          if (voice.setupStep === "recorder") return "Checking the recorder…"
          return ""
        }
      }
      Row {
        spacing: Style.space(8)
        Button {
          objectName: "enableVoice"
          text: root.client.voice.setupFailed ? "Retry" : "Enable voice"
          bordered: true
          visible: !root.client.voice.ready && !root.client.voice.setupBusy && root.client.voice.modelState !== "damaged"
          enabled: !root.client.voice.modelBusy && !root.client.voice.active && root.client.voice.runtimeState !== "checking"
          onClicked: root.client.voice.enable()
        }
        Button {
          text: "Download again"
          bordered: true
          visible: root.client.voice.modelState === "damaged"
          enabled: !root.client.voice.modelBusy && !root.client.voice.setupBusy && !root.client.voice.active
          onClicked: root.client.voice.redownload()
        }
        Button {
          objectName: "cancelSetup"
          visible: root.client.voice.modelBusy || root.client.voice.setupBusy
          text: "Cancel"
          bordered: true
          onClicked: root.client.voice.setupBusy ? root.client.voice.cancelSetup() : root.client.voice.cancelDownload()
        }
        Button {
          text: "Remove model"
          bordered: true
          enabled: !root.client.voice.modelBusy && !root.client.voice.setupBusy && !root.client.voice.active
            && (root.client.voice.modelState === "installed" || root.client.voice.modelState === "damaged")
          onClicked: root.client.voice.manage("remove")
        }
      }
      Rectangle {
        visible: root.client.voice.modelBusy || root.client.voice.setupStep === "model"
        width: parent.width
        height: Style.space(4)
        color: Qt.darker(root.foreground, 2)
        Rectangle {
          height: parent.height
          // Bound before the shell injects the client, and total is 0 until the download reports it.
          width: root.client && root.client.voice && root.client.voice.total > 0
            ? parent.width * Math.min(1, root.client.voice.received / root.client.voice.total) : 0
          color: Color.accent
        }
      }
      Button {
        text: (root.client.voiceSendOnStop ? "● " : "○ ") + "Send when I stop"
        bordered: true
        onClicked: if (!root.client.saveVoiceSendOnStop(!root.client.voiceSendOnStop)) root.result("Could not save the voice preference.", true)
      }
      Label { width: parent.width; text: root.client.voiceSendOnStop ? "The transcript is sent immediately as a normal chat message." : "Default: append the transcript to the draft to edit before sending." }
      Label { width: parent.width; visible: text !== ""; text: root.client.voice.error; color: root.urgent }
      Label { text: "Shortcut"; font.bold: true }
      Label {
        objectName: "shortcutState"
        width: parent.width
        text: "Keyboard shortcut: " + root.shortcutKeys + " (" + ({found: "set up", missing: "not set up", unknown: "could not check"}[root.shortcutState]
          || "checking") + ")"
      }
      Button {
        objectName: "copyShortcut"
        text: "Copy setup"
        bordered: true
        enabled: !shortcutCopy.running
        onClicked: root.copyShortcut()
      }
      Label {
        width: parent.width
        text: root.shortcutFeedback || "Shows or hides this panel. The plugin never edits your Hyprland config: Copy setup puts the snippet on the clipboard for you to add."
        color: root.shortcutFailed ? root.urgent : root.foreground
      }
      Row {
        spacing: Style.space(8)
        Label { anchors.verticalCenter: parent.verticalCenter; text: "Connection"; font.bold: true }
        PanelActionButton {
          objectName: "privacyToggle"
          anchors.verticalCenter: parent.verticalCenter
          iconText: root.client ? root.client.privacyIcon : ""
          tooltipText: root.client ? root.client.privacyTooltip : ""
          foreground: root.foreground
          fontFamily: root.fontFamily
          onClicked: root.client.setPrivacyMasked(!root.client.privacyMasked)
        }
      }
      Label {
        width: parent.width
        text: root.masked
          ? "Hosts, addresses and URLs are hidden for screen sharing; their fields are read-only until you show them."
          : "Shown until the panel closes."
      }

      Row {
        spacing: Style.space(8)
        Button {
          text: root.remoteMode ? "This computer" : "● This computer"
          bordered: true
          onClicked: { root.remoteMode = false; root.apply(false) }
        }
        Button {
          text: root.remoteMode ? "● Remote" : "Remote"
          bordered: true
          onClicked: root.remoteMode = true
        }
      }
      // Remote-only fields; "This computer" needs nothing else.
      Column {
        width: parent.width
        spacing: Style.space(8)
        visible: root.remoteMode

        Label { width: parent.width; text: "Remote device · IP address or DNS name" }
        Row {
          visible: root.client.tailnet.available
          spacing: Style.space(8)
          Label { anchors.verticalCenter: parent.verticalCenter; text: "Tailnet devices" }
          Button { text: root.client.tailnet.loading ? "Refreshing…" : "Refresh"; onClicked: root.client.tailnet.refresh() }
        }
        ListView {
          objectName: "peerList"
          visible: root.client.tailnet.available
          width: parent.width
          height: Math.min(contentHeight, Style.space(125))
          clip: true
          spacing: Style.space(4)
          model: root.client.tailnet.peers
          delegate: Item {
            id: peer
            required property var modelData
            readonly property string address: modelData.dnsName || modelData.ip
            width: ListView.view.width
            height: peerText.implicitHeight + Style.space(6)

            Rectangle {
              anchors.fill: parent
              radius: Style.space(4)
              color: peerArea.containsMouse || root.host === peer.address
                ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08) : "transparent"
            }
            Text {
              id: peerText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.leftMargin: Style.space(6)
              anchors.verticalCenter: parent.verticalCenter
              color: peer.modelData.online ? root.foreground : Qt.darker(root.foreground, 1.6)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
              textFormat: Text.PlainText
              // OS and online state stay visible so a device can still be chosen while masked.
              text: (peer.modelData.online ? "● " : "○ ") + root.client.displayValue(peer.modelData.hostName)
                + " · " + peer.modelData.os + " · " + (peer.modelData.online ? "online" : "offline")
                + "\n   " + root.client.displayValue(peer.address)
            }
            MouseArea {
              id: peerArea
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: {
                root.https = true
                root.advanced = false
                portField.text = ""
                hostField.text = peer.address
                root.feedback = ""
              }
            }
          }
        }
        Field { id: hostField; objectName: "hostField"; visible: !root.masked; placeholderText: "100.x.x.x or device.tailnet.ts.net" }
        MaskField { id: hostMask; objectName: "hostMask"; visible: root.masked; text: Privacy.maskValue(hostField.text); placeholderText: hostField.placeholderText }
        Button {
          text: root.https ? "Transport: Tailscale HTTPS (tailscale serve)" : "Transport: Direct"
          bordered: true
          onClicked: {
            root.https = !root.https
            // Swap the untouched default between the two transports.
            if (root.https && portField.text.trim() === "4317") portField.text = ""
            else if (!root.https && portField.text.trim() === "") portField.text = "4317"
          }
        }
        Label { width: parent.width; text: root.https ? "HTTPS port (empty = 443, the tailscale serve default)" : "Daemon port" }
        Field { id: portField; visible: !root.masked; text: ""; placeholderText: root.https ? "443" : "4317" }
        MaskField { objectName: "portMask"; visible: root.masked; text: Privacy.maskValue(portField.text); placeholderText: portField.placeholderText }
        Button {
          text: (root.advanced ? "▾ " : "▸ ") + "Advanced: custom URL"
          onClicked: root.advanced = !root.advanced
        }
        Field { id: customField; visible: root.advanced && !root.masked; placeholderText: "wss://device.tailnet.ts.net/ws" }
        MaskField { visible: root.advanced && root.masked; text: Privacy.maskUrl(customField.text); placeholderText: customField.placeholderText }
        Field { id: tokenField; password: true; placeholderText: "Remote token (leave empty to keep saved token)" }
      }
      Label { text: "Resulting URL" }
      Field { objectName: "resultField"; text: root.masked ? Privacy.maskUrl(root.candidateUrl) : root.candidateUrl; readOnly: true; selectByMouse: true }
      Label { width: parent.width; visible: root.validation !== ""; text: root.validation; color: root.urgent }
      Row {
        spacing: Style.space(8)
        Button { text: "Test connection"; bordered: true; enabled: !root.validation && root.client.testState !== "testing"; onClicked: root.apply(true) }
        Button { text: "Save & connect"; bordered: true; enabled: !root.validation; onClicked: root.apply(false) }
        // A passing test does not switch the live connection by itself; offer it right here.
        Button {
          visible: root.client.testState === "ok" && root.testedUrl === root.candidateUrl && root.candidateUrl !== root.client.serverUrl
          text: "Use this connection"
          bordered: true
          onClicked: root.apply(false)
        }
      }
      Label {
        width: parent.width
        visible: text !== ""
        text: root.working ? "Saving token…" : root.shown(root.feedback)
        color: root.failed ? root.urgent : Color.accent
      }
      Label {
        width: parent.width
        visible: text !== ""
        text: root.shown(root.client.testMessage)
        color: root.client.testState === "failed" ? root.urgent : root.client.testState === "ok" ? Color.accent : Qt.darker(root.foreground, 1.4)
      }
      Label { width: parent.width; visible: root.remoteMode; text: "On the Mac (select and copy):" }
      TextEdit {
        visible: root.remoteMode
        width: parent.width
        readOnly: true
        selectByMouse: true
        wrapMode: TextEdit.Wrap
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        textFormat: TextEdit.PlainText
        text: "tailscale serve --bg 4317\npbcopy < ~/.gentle-dot/token"
      }
    }
  }
}
