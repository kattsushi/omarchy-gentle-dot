import test from 'node:test';
import { poll, qml } from './composer-harness.test.mjs';

// Fake `node` commands for Voice.qml: they answer model.mjs and setup.mjs like the real CLIs do,
// without npm, a download or a recorder.
const status = `
  */model.mjs) echo '{"type":"model","state":"missing","path":"/m","missing":["encoder.int8.onnx"],"damaged":[]}' ;;
  */setup.mjs)
    case "$2" in
      status)
        echo '{"type":"runtime","state":"missing","source":"","version":"","dir":"/d/runtime","message":"Voice needs a one-time setup: Settings → Voice → Enable voice."}'
        echo '{"type":"recorder","state":"missing","command":"","message":"Install pw-record (PipeWire) or parec (pulseaudio-utils) to record voice."}' ;;`;
const node = enable => `#!/bin/sh
case "$1" in${status}
      enable)
${enable} ;;
    esac ;;
esac
`;
const files = {
  'node-ok': node(`
        echo '{"type":"runtime","state":"missing","source":"","version":"","dir":"/d/runtime"}'
        echo '{"type":"setup","step":"runtime","state":"installing"}'
        echo '{"type":"runtime","state":"installed","source":"runtime","version":"2.0.1","dir":"/d/runtime"}'
        echo '{"type":"setup","step":"model","state":"downloading"}'
        echo '{"type":"progress","received":487170055,"total":487170055}'
        echo '{"type":"model","state":"installed","path":"/m","missing":[],"damaged":[]}'
        echo '{"type":"setup","step":"recorder","state":"checking"}'
        echo '{"type":"recorder","state":"found","command":"pw-record"}'
        echo '{"type":"setup","step":"done","state":"ready"}'`),
  'node-fail': node(`
        echo '{"type":"setup","step":"runtime","state":"installing"}'
        echo '{"type":"error","code":"runtime_install_failed","message":"Installing sherpa-onnx-node 2.0.1 failed (npm exit 1): npm error 404 Not Found"}'
        echo '{"type":"runtime","state":"missing","source":"","version":"","dir":"/d/runtime"}'
        echo '{"type":"model","state":"missing","path":"/m","missing":["encoder.int8.onnx"],"damaged":[]}'
        exit 1`),
  'node-slow': node(`
        trap 'kill $! 2>/dev/null; echo "{\\"type\\":\\"error\\",\\"code\\":\\"cancelled\\",\\"message\\":\\"Voice setup cancelled.\\"}"; exit 0' TERM
        echo '{"type":"setup","step":"runtime","state":"installing"}'
        sleep 10 >/dev/null 2>&1 &
        wait`)
};

const helpers = `
    function eq(actual, expected, what) { if (actual !== expected) throw Error((what || "") + " expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)) }
    function shown(item, out) {
      out = out || []
      if (!item || item.visible === false) return out
      if (typeof item.text === "string" && item.text !== "") out.push(item.text)
      var kids = item.children || []
      for (var i = 0; i < kids.length; i++) shown(kids[i], out)
      return out
    }
    function screen() { return shown(settings).join("\\n") }
    function has(text, what) { var s = screen(); if (s.indexOf(text) < 0) throw Error((what || "") + ": missing " + JSON.stringify(text) + " in\\n" + s) }
    function lacks(text, what) { var s = screen(); if (s.indexOf(text) >= 0) throw Error((what || "") + ": unexpected " + JSON.stringify(text) + " in\\n" + s) }
    function path(name) { return String(Qt.resolvedUrl(name)).replace(/^file:\\/\\//, "") }
    function state() {
      var v = client.voice
      return "runtime=" + v.runtimeState + " model=" + v.modelState + " recorder=" + v.recorderState + " setupBusy=" + v.setupBusy
        + " modelBusy=" + v.modelBusy + " step=" + v.setupStep + " error=" + JSON.stringify(v.error)
    }
    ${poll}
    function idle() { until(function() { return !client.voice.setupBusy }, 10000, "setup still busy: " + state()) }
    // A click on Enable voice starts setup.mjs at once.
    function enableClicked(button) { press(button); check(client.voice.setupBusy, "Enable voice did not start the setup: " + state()) }`;

test('Settings → Voice: Enable voice installs and downloads with progress, errors, retry and cancel', async t => {
  await qml(t, `
  Plugin.Client {
    id: client
    entrySettings: ({notifications: false})
    nodePath: String(Qt.resolvedUrl("node-ok")).replace(/^file:\\/\\//, "")
    shell: QtObject { function updateEntryInline(id, settings) { return true } }
  }
  FloatingWindow {
    visible: true; width: 640; height: 2400
    Plugin.SettingsView { id: settings; client: client; anchors.fill: parent; hyprctlCommand: "true" }
  TestCase {
    id: checks; when: false
    ${helpers}
    function run() {
      try {
        var voice = client.voice
        // The status of a fresh install, from setup.mjs status and model.mjs status.
        until(function() { return voice.runtimeState === "missing" && voice.recorderState === "missing" && voice.modelState === "missing" }, 10000, "status")
        // Both status commands have finished (Enable voice and the mic wait for them).
        until(function() { return !voice.setupBusy && !voice.modelBusy }, 10000, "status commands still running")
        has("Speech runtime (sherpa-onnx-node 2.0.1) · not installed")
        has("Parakeet v3 · missing")
        has("Recorder · missing. Install pw-record (PipeWire) or parec (pulseaudio-utils) to record voice.")
        lacks("pnpm")
        var enable = findChild(settings, "enableVoice")
        check(enable && enable.visible && enable.enabled, "Enable voice button")
        eq(enable.text, "Enable voice")
        check(!findChild(settings, "cancelSetup").visible, "no Cancel while idle")
        // The mic sends you here until voice is set up.
        client.view = "chat"
        eq(voice.start(), false)
        eq(client.view, "settings")
        eq(client.settingsSection, "voice")

        // Progress as setup.mjs reports it.
        voice.setupBusy = true
        voice.handleSetup(JSON.stringify({type: "setup", step: "runtime", state: "installing"}))
        has("Installing the speech runtime…")
        check(findChild(settings, "cancelSetup").visible, "Cancel while busy")
        check(!enable.visible, "no Enable voice while busy")
        voice.handleSetup(JSON.stringify({type: "setup", step: "model", state: "downloading"}))
        voice.handleSetup(JSON.stringify({type: "progress", received: 100000000, total: 487170055}))
        has("Downloading the model… 100.0 / 487.2 MB")
        voice.handleSetup(JSON.stringify({type: "model", state: "verifying"}))
        has("Verifying the model…")
        voice.handleSetup(JSON.stringify({type: "setup", step: "recorder", state: "checking"}))
        has("Checking the recorder…")
        voice.setupBusy = false
        voice.setupStep = ""
        voice.modelState = "missing"

        // A failure: its message, the state it left, and a Retry.
        client.nodePath = path("node-fail")
        enableClicked(enable)
        idle()
        has("Installing sherpa-onnx-node 2.0.1 failed (npm exit 1): npm error 404 Not Found")
        eq(enable.text, "Retry")
        eq(voice.runtimeState, "missing")

        // Cancel: the setup process gets SIGTERM and reports it.
        client.nodePath = path("node-slow")
        enableClicked(enable)
        until(function() { return voice.setupStep === "runtime" }, 10000, "slow setup started")
        has("Installing the speech runtime…")
        press(findChild(settings, "cancelSetup"))
        idle()
        has("Voice setup cancelled.")
        eq(enable.text, "Enable voice")

        // Success: runtime, model and recorder all ready.
        client.nodePath = path("node-ok")
        enableClicked(enable)
        idle()
        eq(voice.runtimeState, "installed", state())
        eq(voice.modelState, "installed", state())
        eq(voice.recorderState, "found", state())
        eq(voice.error, "", state())
        check(!enable.visible, "Enable voice hidden when ready")
        has("Speech runtime (sherpa-onnx-node 2.0.1) · installed")
        has("Recorder · pw-record")
        has("Voice is ready.")

        // A developer checkout's own node_modules counts as installed.
        voice.handleSetup(JSON.stringify({type: "runtime", state: "installed", source: "plugin", version: "2.0.1"}))
        has("Speech runtime (sherpa-onnx-node 2.0.1) · installed (plugin node_modules)")
        // The worker saying the runtime is gone brings the setup back.
        voice.handleWorker(JSON.stringify({type: "error", code: "runtime_missing", message: "Voice needs a one-time setup: Settings → Voice → Enable voice."}))
        eq(voice.runtimeState, "missing")
        check(enable.visible, "Enable voice after runtime_missing")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `, { files, timeout: 40000 });
});
