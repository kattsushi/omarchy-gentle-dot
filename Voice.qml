import QtQuick
import Quickshell.Io

// Owned by Client, not a panel: one capture/recognizer across all window modes.
Item {
  id: voice
  required property var client
  readonly property string basePath: decodeURIComponent(String(Qt.resolvedUrl("voice/")).replace(/^file:\/\//, ""))
  property string modelState: "checking"
  property string modelPath: ""
  property var damagedFiles: []
  property bool modelBusy: false
  property real received: 0
  property real total: 487170055
  property string state: "idle"
  property real seconds: 0
  property real rms: 0
  property string error: ""
  property string lastTranscript: ""
  property bool sendAfterStop: false
  property var pendingCommand: null
  readonly property bool active: state !== "idle"
  // Settings → Voice → Enable voice (setup.mjs): the speech runtime, the model and a recorder.
  property string runtimeState: "checking"   // checking | installed | missing
  property string runtimeSource: ""          // runtime ($XDG_DATA_HOME) | plugin (a checkout's node_modules)
  property string recorderState: "checking"  // checking | found | missing
  property string recorder: ""
  property string recorderMessage: ""
  property bool setupBusy: false
  property string setupStep: ""              // runtime | model | recorder while setupBusy
  property bool setupFailed: false
  readonly property bool ready: runtimeState === "installed" && modelState === "installed"
  signal transcriptReady(string text, bool sendNow)

  function manage(command) {
    if (modelBusy || setupBusy || active) return false
    error = ""
    if (command === "remove" || command === "redownload") worker.running = false
    modelBusy = true
    manager.command = [client.nodePath || "node", basePath + "model.mjs", command]
    manager.running = true
    return true
  }

  function cancelDownload() { if (modelBusy) manager.signal(15) }

  function runSetup(command) {
    setupBusy = true
    setupStep = ""
    setup.launched = false
    setup.command = [client.nodePath || "node", basePath + "setup.mjs", command]
    setup.running = true
  }

  // Runtime and recorder state; the model's comes from manage("status").
  function checkSetup() {
    if (setupBusy) return false
    runSetup("status")
    return true
  }

  // Installs the runtime if it does not load yet, downloads the model, checks the recorder.
  function enable() {
    if (setupBusy || modelBusy || active) return false
    error = ""
    setupFailed = false
    received = 0
    runSetup("enable")
    return true
  }

  function cancelSetup() { if (setupBusy) setup.signal(15) }

  function handleSetup(line) {
    var event
    try { event = JSON.parse(line) } catch (e) { return }
    switch (event.type) {
      case "runtime":
        runtimeState = event.state === "installed" ? "installed" : "missing"
        runtimeSource = String(event.source || "")
        break
      case "recorder":
        recorderState = event.state === "found" ? "found" : "missing"
        recorder = String(event.command || "")
        recorderMessage = String(event.message || "")
        break
      case "setup":
        if (event.step !== "done") setupStep = String(event.step || "")
        break
      case "error":
        error = String(event.message || event.code)
        setupFailed = event.code !== "cancelled"
        break
      default:
        handleModel(line)
    }
  }

  // A damaged model must be removed before it can be downloaded again.
  function redownload() { return manage("redownload") }

  function handleModel(line) {
    var event
    try { event = JSON.parse(line) } catch (e) { return }
    if (event.type === "progress") { received = event.received; total = event.total }
    if (event.type === "model") {
      modelState = event.state
      damagedFiles = event.damaged || []
      if (event.path) modelPath = event.path
    }
    if (event.type === "error") {
      error = event.message
      if (modelState !== "installed" && modelState !== "damaged") modelState = "missing"
    }
  }

  function request(command) {
    if (worker.running) worker.write(JSON.stringify(command) + "\n")
    else {
      pendingCommand = command
      worker.command = [client.nodePath || "node", basePath + "transcriber.mjs"]
      worker.running = true
    }
  }

  function start() {
    if (active || modelBusy) return false
    if (modelState !== "installed" || runtimeState === "missing") {
      client.settingsSection = "voice"
      client.view = "settings"
      return false
    }
    error = ""
    seconds = 0
    rms = 0
    sendAfterStop = client.voiceSendOnStop
    state = "loading"
    request({cmd: "start"})
    return true
  }

  function stop() {
    if (state !== "recording") return
    state = "transcribing"
    request({cmd: "stop"})
  }

  function cancel() {
    if (!active || state === "cancelling") return
    sendAfterStop = false
    state = "cancelling"
    request({cmd: "cancel"})
  }

  // Verification is ALWAYS prepare-only, regardless of the saved mode.
  function transcribeFile(path) {
    if (active || modelBusy) return "busy"
    error = ""
    sendAfterStop = false
    state = "transcribing"
    request({cmd: "transcribe_file", path: String(path)})
    return "transcribing"
  }

  function handleWorker(line) {
    var event
    try { event = JSON.parse(line) } catch (e) { return }
    switch (event.type) {
      case "recording":
        if (state === "loading" || state === "recording") { state = "recording"; seconds = event.seconds }
        break
      case "level": rms = event.rms; break
      case "transcribing": if (state !== "cancelling") state = "transcribing"; break
      case "transcript":
        if (state !== "cancelling" && state !== "idle") {
          lastTranscript = String(event.text || "")
          transcriptReady(lastTranscript, sendAfterStop)
          state = "idle"
        }
        break
      case "cancelled": state = "idle"; rms = 0; break
      case "error":
        error = String(event.message || event.code)
        // The worker hashed the files after the recognizer failed to load.
        if (event.code === "model_damaged") modelState = "damaged"
        if (event.code === "runtime_missing") runtimeState = "missing"
        state = "idle"
        rms = 0
        break
    }
  }

  Process {
    id: manager
    stdout: SplitParser { onRead: function(line) { voice.handleModel(line) } }
    onExited: function(code) {
      voice.modelBusy = false
      if (code !== 0 && !voice.error) voice.error = "Model command failed (exit " + code + ")."
    }
  }

  Process {
    id: setup
    // Quickshell emits no exited() when Node cannot be started.
    property bool launched: false
    stdout: SplitParser { onRead: function(line) { voice.handleSetup(line) } }
    onStarted: launched = true
    onRunningChanged: if (!running && !launched && voice.setupBusy) finish(127)
    onExited: function(code) { finish(code) }
    function finish(code) {
      voice.setupBusy = false
      voice.setupStep = ""
      if (code !== 0 && !voice.error) {
        voice.error = code === 127 ? voice.client.nodeMessage : "Voice setup failed (exit " + code + ")."
        voice.setupFailed = true
      }
      if (voice.runtimeState === "checking") voice.runtimeState = "missing"
      if (voice.recorderState === "checking") voice.recorderState = "missing"
    }
  }

  Process {
    id: worker
    stdinEnabled: true
    onStarted: {
      if (voice.pendingCommand) write(JSON.stringify(voice.pendingCommand) + "\n")
      voice.pendingCommand = null
    }
    stdout: SplitParser { onRead: function(line) { voice.handleWorker(line) } }
    // Native sherpa-onnx may log resampling diagnostics to stderr; never treat
    // those as protocol frames or send them to the daemon.
    onExited: function(code) {
      if (voice.active) voice.error = "Voice worker stopped (exit " + code + ")."
      voice.state = "idle"
      voice.rms = 0
    }
  }

  Component.onCompleted: Qt.callLater(function() {
    voice.manage("status")
    voice.checkSetup()
  })
}
