import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { poll, qml } from './composer-harness.test.mjs';

// S22.1: the bridge relays daemon frames and its own results on one stdout, each line wrapped as
// {"from":"daemon"|"bridge","msg":...}. A daemon frame never acts as a local result, whatever its
// type, and a bridge result is only taken when it answers a request this client made, with the
// paths and ids it asked for.

function png(width = 4, height = 3) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const OWN = 'u_OwnOwnOwnOwnOwnOwnOw-_';
const MAC = 'u_AbCdEfGhIjKlMnOpQr-_12';
const OTHER = 'u_OtherOtherOtherOther_1';
// Never a file the test makes: a forged result pointing at it must change nothing.
const SECRET = '/etc/forged-secret-path';

test('daemon frames never act as bridge results; bridge results only answer this client\'s own requests', async t => {
  const output = await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false}); openCommand: [file("open")]
    property var sent: []; function send(obj) { sent = sent.concat([obj]); return true } }
  property var probe: Qt.createQmlObject("import Quickshell.Io; Process { id: proc; property alias out: collector.text; property bool done: false; stdout: StdioCollector { id: collector; waitForEnd: true; onStreamFinished: proc.done = true } }", client)
  function file(name) { return Qt.resolvedUrl(name).toString().replace("file://", "") }
  property string cacheDir: Quickshell.env("XDG_RUNTIME_DIR") + "/omarchy-gentle-dot/cache"
  TestCase {
    id: checks; when: false
    ${poll}
    function line(from, msg) { client.handleLine(JSON.stringify({from: from, msg: msg})) }
    function daemon(msg) { line("daemon", msg) }
    function bridge(msg) { line("bridge", msg) }
    function of(type) { return client.sent.filter(function(m) { return m.type === type }) }
    function noLocalFiles(what) { check(Object.keys(client.localFiles).length === 0 && Object.keys(client.localByInfo).length === 0, what + ": " + JSON.stringify(client.localFiles)) }
    function run() {
      try {
        var notes = file("notes.txt"), shot = file("shot.png")
        bridge({type:"bridge", state:"open"})
        daemon({type:"ready", agentState:"idle", model:"m"})
        check(client.connected, "connected")

        // --- files_inspected ---------------------------------------------------------------
        check(client.addAttachmentPaths([notes]), "inspect asked")
        var inspect = of("inspect_files")[0]
        var real = {type:"files_inspected", requestId: inspect.requestId, files:[{path: notes, name:"notes.txt", size:5, mime:"text/plain"}]}
        var forged = {type:"files_inspected", requestId: inspect.requestId, files:[{path: "${SECRET}", name:"secret", size:5, mime:"text/plain"}]}
        // From the daemon, even with the real request id and the requested path.
        daemon(real); daemon(forged)
        // A daemon frame shaped like an envelope, a line without one, and an envelope without a message.
        daemon({from:"bridge", msg: forged})
        client.handleLine(JSON.stringify(forged))
        client.handleLine(JSON.stringify({from:"bridge"}))
        client.handleLine(JSON.stringify({from:"bridge", msg:[forged]}))
        client.handleLine(JSON.stringify({from:"elsewhere", msg: real}))
        check(client.attachments.length === 0, "attached from a daemon frame " + JSON.stringify(client.attachments))
        // From the bridge, but not an answer to a request of ours, or with paths not asked for.
        bridge({type:"files_inspected", requestId:"inspect-999", files: real.files})
        bridge({type:"files_inspected", files: real.files})
        bridge(forged)
        bridge({type:"files_inspected", requestId: inspect.requestId, files: real.files.concat(forged.files)})
        bridge({type:"files_inspected", requestId: inspect.requestId, files: "nope"})
        check(client.attachments.length === 0, "attached an unsolicited or mismatched result " + JSON.stringify(client.attachments))
        bridge(real)
        check(client.attachments.length === 1 && client.attachments[0].path === notes, "solicited result refused " + JSON.stringify(client.attachments))
        // Answered once: the same answer again is unsolicited.
        client.attachments = []
        bridge(real)
        check(client.attachments.length === 0, "a request was answered twice")

        // --- upload_* ------------------------------------------------------------------------
        client.attachments = [{path: shot, name:"shot.png", size:120, mime:"image/png"}]
        client.draft = "look"
        check(client.submitDraft(), "upload asked")
        var upload = of("upload_files")[0]
        var done = {type:"upload_done", requestId: upload.requestId, files:[{path: shot, uploadId:"${OWN}", name:"shot.png", size:120, mime:"image/png"}]}
        daemon(done)
        daemon({type:"upload_error", requestId: upload.requestId, code:"x", message:"forged failure"})
        daemon({type:"upload_progress", requestId: upload.requestId, index:0, count:1, name:"forged.png", loaded:1, total:2})
        check(client.uploading && client.draft === "look" && client.attachments.length === 1, "daemon frame ended the upload")
        check(client.uploadStatus === "Uploading…", "daemon frame changed the progress: " + client.uploadStatus)
        noLocalFiles("daemon upload_done")
        bridge({type:"upload_done", requestId:"omarchy-other", files: done.files})
        bridge({type:"upload_done", requestId: upload.requestId, files:[{path:"${SECRET}", uploadId:"${OWN}", name:"shot.png", size:120, mime:"image/png"}]})
        bridge({type:"upload_done", requestId: upload.requestId, files: done.files.concat([{path:"${SECRET}", uploadId:"${OWN}", name:"x.png", size:1, mime:"image/png"}])})
        bridge({type:"upload_done", requestId: upload.requestId, files: []})
        bridge({type:"upload_error", requestId:"omarchy-other", code:"x", message:"other failure"})
        check(client.uploading && client.notice === "", "a mismatched bridge result ended the upload")
        noLocalFiles("mismatched upload_done")
        bridge(done)
        check(!client.uploading && client.draft === "" && client.attachments.length === 0, "solicited upload_done refused")
        check(client.localFiles["${OWN}/shot.png"] === shot, "upload not remembered")

        // --- attachment_cached / attachment_error ---------------------------------------------
        daemon({type:"history", messages:[{id:"m", role:"user", text:"", attachments:[
          {name:"mac.png", size:70, mime:"image/png", uploadId:"${MAC}"}, {name:"shot.png", size:120, mime:"image/png", uploadId:"${OWN}"}]}]})
        var fetch = of("fetch_attachment").filter(function(m) { return m.name === "mac.png" })[0]
        check(fetch && fetch.uploadId === "${MAC}", "fetch asked " + JSON.stringify(client.sent))
        var cached = cacheDir + "/${MAC}/mac.png"
        var good = {type:"attachment_cached", requestId: fetch.requestId, uploadId:"${MAC}", name:"mac.png", path: cached, mime:"image/png"}
        function loading() { return client.remoteFiles["${MAC}/mac.png"].state === "loading" }
        daemon(good)
        daemon({type:"attachment_error", requestId: fetch.requestId, uploadId:"${MAC}", name:"mac.png", code:"not_found"})
        check(loading(), "a daemon frame settled the fetch")
        bridge({type:"attachment_cached", requestId:"fetch-999", uploadId:"${MAC}", name:"mac.png", path: cached, mime:"image/png"})
        bridge({type:"attachment_cached", requestId: fetch.requestId, uploadId:"${MAC}", name:"mac.png", path:"${SECRET}", mime:"image/png"})
        bridge({type:"attachment_cached", requestId: fetch.requestId, uploadId:"${MAC}", name:"mac.png", path: cacheDir + "/${MAC}/../../../forged/mac.png", mime:"image/png"})
        bridge({type:"attachment_cached", requestId: fetch.requestId, uploadId:"${OTHER}", name:"mac.png", path: cacheDir + "/${OTHER}/mac.png", mime:"image/png"})
        bridge({type:"attachment_cached", requestId: fetch.requestId, uploadId:"${MAC}", name:"other.png", path: cacheDir + "/${MAC}/other.png", mime:"image/png"})
        bridge({type:"attachment_error", requestId: fetch.requestId, uploadId:"${OTHER}", name:"mac.png", code:"not_found"})
        check(loading(), "a mismatched bridge result settled the fetch " + JSON.stringify(client.remoteFiles))
        bridge(good)
        var entry = client.remoteFiles["${MAC}/mac.png"]
        check(entry.state === "ready" && entry.path === cached, "solicited attachment_cached refused " + JSON.stringify(entry))

        // --- opening and viewing only known files ------------------------------------------------
        check(client.openFile("${SECRET}") === false, "opened an unknown path")
        check(client.openAttachment({name:"secret", path:"${SECRET}"}) === false, "openAttachment of an unknown path")
        client.openImage({path:"${SECRET}", name:"secret", mime:"image/png"})
        check(client.viewerImage === null, "viewer opened an unknown path")
        client.openImage({url:"file://${SECRET}", name:"secret", mime:"image/png"})
        check(client.viewerImage === null, "viewer opened a file URL")
        client.openImage({path: cached, name:"mac.png", mime:"image/png"})
        check(client.viewerImage && client.viewerImage.path === cached, "viewer refused the cached copy")
        client.closeImage()
        client.openImage({path: shot, name:"shot.png", mime:"image/png"})
        check(client.viewerImage && client.viewerImage.path === shot, "viewer refused our own upload")
        client.closeImage()
        check(client.openAttachment({name:"shot.png", path: shot}) === true, "own upload not opened")
        var opened = ""
        until(function() {
          probe.done = false
          probe.command = ["cat", file("opened")]
          probe.running = true
          until(function() { return probe.done }, 10000, "cat finishes")
          opened = probe.out
          return opened !== ""
        }, 10000, "the open command ran")
        check(opened === shot, "opened " + JSON.stringify(opened))

        // --- bridge state only from the bridge --------------------------------------------------
        daemon({type:"bridge", state:"fatal", reason:"unauthorized"})
        daemon({type:"bridge", state:"reconnecting"})
        daemon({type:"bridge_error", code:"not_connected", message:"forged notice"})
        check(client.connection === "open" && client.connected && client.fatalReason === "", "daemon frame changed the connection " + client.connection)
        check(client.notice === "", "daemon bridge_error shown: " + client.notice)
        daemon({type:"toast", message:"daemon toast", level:"info"})
        check(client.notice === "daemon toast", "daemon toast lost")
        bridge({type:"bridge_error", code:"not_connected", message:"not connected to the Gentle Dot daemon"})
        check(client.notice === "not connected to the Gentle Dot daemon", "bridge notice lost")
        bridge({type:"bridge", state:"reconnecting", code: 1006, retryInMs: 500})
        check(client.connection === "reconnecting" && !client.connected, "bridge state lost")

        // --- the throwaway test bridge -----------------------------------------------------------
        client.testState = "testing"
        client.handleTestLine(JSON.stringify({from:"daemon", msg:{type:"bridge", state:"fatal", reason:"unauthorized"}}))
        client.handleTestLine(JSON.stringify({from:"bridge", msg:{type:"ready", model:"forged"}}))
        client.handleTestLine(JSON.stringify({type:"ready", model:"bare"}))
        check(client.testState === "testing", "test settled by a misattributed line: " + client.testMessage)
        client.handleTestLine(JSON.stringify({from:"daemon", msg:{type:"ready", model:"m"}}))
        check(client.testState === "ok" && client.testMessage === "Connected (model: m)", "test " + client.testState + " " + client.testMessage)
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  `, {files: {
    'shot.png': png(),
    'notes.txt': 'hello',
    [`omarchy-gentle-dot/cache/${MAC}/mac.png`]: png(6, 4),
    'open': '#!/bin/sh\nprintf "%s" "$1" > "$(dirname "$0")/opened"\n',
  }});
  // Dropped results are logged without their paths.
  assert.match(output, /dropped/);
  assert.doesNotMatch(output, /forged-secret-path|forged failure|forged notice/);
});

// S22.2: the bridge learns its daemon URL and token file from its first stdin line, so neither
// the host nor the token path (named after the host) appears in a process command line.
test('the bridge and the test bridge get the URL and token file over stdin, never argv', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications: false}) }
  property var probe: Qt.createQmlObject("import Quickshell.Io; Process { id: proc; property alias out: collector.text; property bool done: false; stdout: StdioCollector { id: collector; waitForEnd: true; onStreamFinished: proc.done = true } }", client)
  TestCase {
    id: checks; when: false
    ${poll}
    function path(name) { return String(Qt.resolvedUrl(name)).replace(/^file:\\/\\//, "") }
    function read(name) {
      probe.done = false
      probe.command = ["cat", path(name)]
      probe.running = true
      until(function() { return probe.done }, 10000, "cat finishes")
      return probe.out
    }
    function run() {
      try {
        client.configure({nodePath: path("node-fake"), serverUrl: "wss://mac.example:8443/ws",
          tokenFile: "~/.config/gentle-dot/remotes/mac.example.token", notifications: false})
        until(function() { return client.connection === "fatal" }, 10000, "the fake bridge never ran: " + client.connection)
        check(client.fatalMessage === "fake bridge ran", "fatal " + client.fatalMessage)
        check(client.testConnection("ws://other.example:4317/ws", "/keys/other.example.token"), "test started")
        until(function() { return client.testState === "failed" }, 10000, "test bridge never ran: " + client.testState)
        var argv = read("argv.log")
        check(argv.split("\\n").filter(function(l) { return l }).length === 2, "argv " + argv)
        check(argv.indexOf("example") < 0, "a host or token path on argv: " + argv)
        var lines = read("stdin.log").split("\\n").filter(function(l) { return l }).map(function(l) { return JSON.parse(l) })
        check(lines.length === 2, "stdin " + JSON.stringify(lines))
        check(lines[0].type === "config" && lines[0].url === "wss://mac.example:8443/ws"
          && lines[0].tokenFile === "~/.config/gentle-dot/remotes/mac.example.token", "bridge config " + JSON.stringify(lines[0]))
        check(lines[1].type === "config" && lines[1].url === "ws://other.example:4317/ws"
          && lines[1].tokenFile === "/keys/other.example.token", "test config " + JSON.stringify(lines[1]))
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 50; running: true; onTriggered: checks.run() }
  `, { files: {
    'node-fake': `#!/bin/sh
d=$(dirname "$0")
if [ "$1" = --version ]; then echo v22.3.0; exit 0; fi
printf '%s\\n' "$*" >> "$d/argv.log"
IFS= read -r line
printf '%s\\n' "$line" >> "$d/stdin.log"
echo '{"from":"bridge","msg":{"type":"bridge","state":"fatal","reason":"bad_url","message":"fake bridge ran"}}'
exit 2
`,
  } });
});

// S22.2, the remaining child processes: the token, its path, image paths and the health URL
// travel over stdin; their command lines are fixed words.
test('token writer, token probe, image copy and health probe keep private values off argv', async () => {
  const client = await readFile(new URL('../Client.qml', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../SettingsView.qml', import.meta.url), 'utf8');
  const command = (source, id) => {
    const match = source.match(new RegExp(`${id}\\.command = ([^\\n]*(?:\\n\\s+[^\\n]*)*?)\\n\\s*${id}\\.(?:running|stdinEnabled|launched|done|callback)`));
    assert.ok(match, `${id}.command not found`);
    return match[1];
  };
  for (const [source, id, banned] of [
    [client, 'tokenWriter', /expandHome|path\b|secret|token\b/],
    [client, 'tokenProbe', /expandHome|path\b/],
    [client, 'imageCopier', /image\.path|\.path\b/],
    [settings, 'healthProbe', /healthUrlOf|url\b/],
  ]) assert.doesNotMatch(command(source, id), banned, `${id} passes a private value on argv`);
});

test('the remote health check gives curl its URL on stdin (-K -), never on argv', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications: false}) }
  function path(name) { return String(Qt.resolvedUrl(name)).replace(/^file:\\/\\//, "") }
  FloatingWindow {
    visible: true; width: 640; height: 2400
    Plugin.SettingsView { id: settings; client: client; anchors.fill: parent; hyprctlCommand: "true"; curlCommand: [path("curl")] }
  }
  property var probe: Qt.createQmlObject("import Quickshell.Io; Process { id: proc; property alias out: collector.text; property bool done: false; stdout: StdioCollector { id: collector; waitForEnd: true; onStreamFinished: proc.done = true } }", client)
  TestCase {
    id: checks; when: false
    ${poll}
    function read(name) {
      probe.done = false
      probe.command = ["cat", path(name)]
      probe.running = true
      until(function() { return probe.done }, 10000, "cat finishes")
      return probe.out
    }
    function run() {
      try {
        client.configured = true
        client.serverUrl = "wss://mac.example:8443/ws"
        client.tokenFile = "/nonexistent/mac.example.token"
        settings.load()
        check(settings.remoteMode && settings.candidateUrl === "wss://mac.example:8443/ws", "remote " + settings.candidateUrl)
        settings.apply(true)
        until(function() { return settings.feedback.indexOf("Reachable at mac.example.") === 0 }, 10000, "health result: " + settings.feedback)
        var argv = read("curl-argv.log")
        check(argv !== "" && argv.indexOf("example") < 0 && argv.indexOf("-K -") >= 0, "curl argv " + argv)
        check(read("curl-stdin.log") === 'url = "https://mac.example:8443/health"\\n', "curl stdin " + JSON.stringify(read("curl-stdin.log")))
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  `, { files: {
    curl: '#!/bin/sh\nd=$(dirname "$0")\nprintf "%s\\n" "$*" >> "$d/curl-argv.log"\ncat >> "$d/curl-stdin.log"\nprintf 200\n',
  } });
});

test('an ask\'s message shows no local images or HTML, and only web links open', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications: false}) }
  FloatingWindow {
    visible: true; width: 500; height: 400
    Plugin.AskCard { id: card; client: client; width: 480
      ask: ({requestId: "q", method: "confirm", title: "Approve?", message: "See ![shot](/etc/forged-secret.png) <img src=/etc/forged-secret.png> <b>bold</b> [docs](https://example.org)"}) }
  }
  TestCase {
    id: checks; when: false
    ${poll}
    function run() {
      try {
        // What the reader sees: no image (an object character), the HTML as text, the link's text.
        var edit = findChild(card, "askMessage")
        var shown = edit.getText(0, edit.length)
        check(shown.indexOf("forged-secret") < 0 && shown.indexOf("\\ufffc") < 0, "ask message " + shown)
        shown = shown.replace(/\\u2060/g, "")
        check(shown.indexOf("See shot") === 0 && shown.indexOf("<b>bold</b>") >= 0 && /docs$/.test(shown.trim()), "ask message " + shown)
        check(card.openLink("file:///etc/passwd") === false, "file link opened")
        check(card.openLink("steam://run/1") === false, "custom scheme opened")
        check(card.openLink("javascript:alert(1)") === false, "javascript link opened")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  `);
});

// PRESERVE: the token writer and probe still work with their path on stdin.
test('a pasted token is still saved 0600 in a 0700 folder, and the probe still finds it', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications: false}) }
  property var probe: Qt.createQmlObject("import Quickshell.Io; Process { id: proc; property alias out: collector.text; property bool done: false; stdout: StdioCollector { id: collector; waitForEnd: true; onStreamFinished: proc.done = true } }", client)
  TestCase {
    id: checks; when: false
    ${poll}
    function run() {
      try {
        var dir = Quickshell.env("XDG_RUNTIME_DIR") + "/remotes dir"
        var path = dir + "/mac.example.token"
        var results = []
        client.tokenFileExists(path, function(ok) { results.push("before:" + ok) })
        until(function() { return results.length === 1 }, 10000, "probe before")
        client.writeToken(path, "  tok-123  ", function(ok) { results.push("write:" + ok) })
        until(function() { return results.length === 2 }, 10000, "write")
        client.tokenFileExists(path, function(ok) { results.push("after:" + ok) })
        until(function() { return results.length === 3 }, 10000, "probe after")
        check(results.join() === "before:false,write:true,after:true", "results " + results.join())
        probe.command = ["sh", "-c", "stat -c %a -- \\"$1\\" \\"$2\\" && cat -- \\"$2\\"", "sh", dir, path]
        probe.running = true
        until(function() { return probe.done }, 10000, "stat finishes")
        check(probe.out === "700\\n600\\ntok-123\\n", "file " + JSON.stringify(probe.out))
        var refused = []
        client.writeToken(path, "a\\nb", function(ok) { refused.push(ok) })
        check(refused.join() === "false", "multi-line token accepted")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  `);
});

// S22.1 (verifier): md4c reads a backtick pair split by a blank line, or left open by the
// collapsed view's 40-line cut, as plain Markdown. A local image named there must never render:
// a reply or ask referring to a real 300x300 image lays out exactly like one referring to a
// missing file.
test('S22.1: a reply or ask cannot render a local image through a split or truncated code span', async t => {
  await qml(t, `
  property string shown: file("s.png")
  property string missing: file("missing.png")
  function file(name) { return Qt.resolvedUrl(name).toString().replace("file://", "") }
  function split(path) { return "\`\\n\\n![x](" + path + ")\\n\\n\`" }
  function truncated(path) {
    var lines = []
    for (var i = 0; i < 39; i++) lines.push("line " + i)
    return lines.join("\\n") + "\\n\` ![x](" + path + ")\\nclosing \`"
  }
  function joined(path) { return "![!](x)[y](" + path + ") and !![[z](x)](" + path + ")" }
  function table(path) { return "| a | b | c |\\n| - | - | - |\\n| \`x | ![i](" + path + ") | y\` |" }
  FloatingWindow {
    visible: true; width: 600; height: 1200
    Column {
      width: 560
      // Calibration: a plain Markdown image of the real file does change the height.
      TextEdit { id: calShown; width: 500; textFormat: TextEdit.MarkdownText; text: "![x](" + shown + ")" }
      TextEdit { id: calMissing; width: 500; textFormat: TextEdit.MarkdownText; text: "![x](" + missing + ")" }
      Plugin.MessageBubble { id: splitShown; width: 500; role: "assistant"; phase: "done"; error: ""; activities: "[]"; text: split(shown) }
      Plugin.MessageBubble { id: splitMissing; width: 500; role: "assistant"; phase: "done"; error: ""; activities: "[]"; text: split(missing) }
      Plugin.MessageBubble { id: cutShown; width: 500; role: "assistant"; phase: "done"; error: ""; activities: "[]"; text: truncated(shown) }
      Plugin.MessageBubble { id: cutMissing; width: 500; role: "assistant"; phase: "done"; error: ""; activities: "[]"; text: truncated(missing) }
      Plugin.MessageBubble { id: tableShown; width: 500; role: "assistant"; phase: "done"; error: ""; activities: "[]"; text: table(shown) }
      Plugin.MessageBubble { id: tableMissing; width: 500; role: "assistant"; phase: "done"; error: ""; activities: "[]"; text: table(missing) }
      Plugin.AskCard { id: askShown; width: 500; ask: ({requestId: "a", method: "confirm", title: "Q", message: split(shown)}) }
      Plugin.AskCard { id: askMissing; width: 500; ask: ({requestId: "b", method: "confirm", title: "Q", message: split(missing)}) }
      Plugin.AskCard { id: askCutShown; width: 500; ask: ({requestId: "c", method: "confirm", title: "Q", message: truncated(shown)}) }
      Plugin.AskCard { id: askJoinShown; width: 500; ask: ({requestId: "e", method: "confirm", title: "Q", message: joined(shown)}) }
      Plugin.AskCard { id: askJoinMissing; width: 500; ask: ({requestId: "f", method: "confirm", title: "Q", message: joined(missing)}) }
      Plugin.MessageBubble { id: joinShown; width: 500; role: "assistant"; phase: "done"; error: ""; activities: "[]"; text: joined(shown) }
      Plugin.MessageBubble { id: joinMissing; width: 500; role: "assistant"; phase: "done"; error: ""; activities: "[]"; text: joined(missing) }
      Plugin.AskCard { id: askCutMissing; width: 500; ask: ({requestId: "d", method: "confirm", title: "Q", message: truncated(missing)}) }
    }
  }
  TestCase {
    id: checks; when: false
    ${poll}
    function run() {
      try {
        until(function() { return calShown.contentHeight >= 300 }, 10000, "the calibration image never rendered: " + calShown.contentHeight)
        check(calMissing.contentHeight < 300, "calibration missing " + calMissing.contentHeight)
        wait(200)
        var pairs = [[splitShown, splitMissing, "reply, blank-line split"], [cutShown, cutMissing, "reply, collapsed cut"],
          [tableShown, tableMissing, "reply, table cells"], [askShown, askMissing, "ask, blank-line split"],
          [askCutShown, askCutMissing, "ask, 39 lines + open backtick"],
          [askJoinShown, askJoinMissing, "ask, pieces joined into ![ "], [joinShown, joinMissing, "reply, pieces joined into ![ "]]
        for (var i = 0; i < pairs.length; i++)
          check(pairs[i][0].implicitHeight === pairs[i][1].implicitHeight,
            pairs[i][2] + ": a local image rendered (" + pairs[i][0].implicitHeight + " vs " + pairs[i][1].implicitHeight + ")")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 200; running: true; onTriggered: checks.run() }
  `, { files: { 's.png': png(300, 300) } });
});

// S22.1 should-fix: an https image in a reply is fetched only after the user asks for it, so a
// daemon (or a prompt-injected model) cannot make this machine request URLs on its own.
test('https Markdown images wait for a click: a placeholder names the host (masked for screen sharing), then the image loads', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications: false}); function send(obj) { return true } }
  FloatingWindow {
    visible: true; width: 600; height: 900
    Plugin.MessageBubble { id: masked; width: 500; role: "assistant"; phase: "done"; error: ""; activities: "[]"
      text: "See ![chart](https://user:pw@images.invalid/c.png)" }
    Plugin.MessageBubble { id: shown; y: 200; width: 500; role: "assistant"; phase: "done"; error: ""; activities: "[]"
      privacyMasked: false; text: "See ![chart](https://images.invalid/c.png)" }
    Plugin.ChatView { id: chat; y: 400; width: 600; height: 400; client: client; model: client.messages }
  }
  function find(item, name, list) {
    list = list || []
    if (item.objectName === name && item.visible) list.push(item)
    for (var i = 0; i < item.children.length; i++) find(item.children[i], name, list)
    return list
  }
  TestCase {
    id: checks; when: false
    ${poll}
    function run() {
      try {
        var asked = []
        masked.loadImage.connect(function(url) { asked.push(url) })
        settle(function() { check(find(masked, "imagePlaceholder").length === 1, "no placeholder") })
        check(find(masked, "markdownImage").length === 0, "loaded before a click")
        check(find(masked, "imagePlaceholderText")[0].text === "Load image from ••••••••", "masked label " + find(masked, "imagePlaceholderText")[0].text)
        settle(function() { check(find(shown, "imagePlaceholderText").length === 1, "shown placeholder") })
        check(find(shown, "imagePlaceholderText")[0].text === "Load image from images.invalid", "shown label " + find(shown, "imagePlaceholderText")[0].text)
        find(masked, "imagePlaceholderHit")[0].clicked(null)
        check(asked.join() === "https://user:pw@images.invalid/c.png", "loadImage " + asked.join())
        settle(function() {
          var images = find(masked, "markdownImage")
          check(images.length === 1 && String(images[0].source) === "https://user:pw@images.invalid/c.png", "image after click")
          check(find(masked, "imagePlaceholder").length === 0, "placeholder after click")
        })
        // Through the chat: the client remembers the choice for the session; only https counts.
        check(client.allowImage("file:///etc/x.png") === false && client.allowImage("http://h.invalid/x.png") === false, "non-https allowed")
        client.handleDaemon({type: "message_done", messageId: "m", text: "![c](https://images.invalid/d.png)"})
        var row = null
        settle(function() { row = chat.itemAtIndex(0); check(row && find(row, "imagePlaceholder").length === 1, "chat placeholder") })
        find(row, "imagePlaceholderHit")[0].clicked(null)
        check(client.loadedImages["https://images.invalid/d.png"] === true, "client did not remember the image")
        settle(function() { check(find(chat.itemAtIndex(0), "markdownImage").length === 1, "chat image after click") })
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 150; running: true; onTriggered: checks.run() }
  `);
});

// Nit: curl reads its URL from a config line, so a quote, backslash or line break in the address
// is refused before anything runs.
test('the health check refuses an address with a quote or backslash instead of writing it into curl\'s config', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications: false}) }
  function path(name) { return String(Qt.resolvedUrl(name)).replace(/^file:\\/\\//, "") }
  FloatingWindow {
    visible: true; width: 640; height: 2400
    Plugin.SettingsView { id: settings; client: client; anchors.fill: parent; hyprctlCommand: "true"; curlCommand: [path("curl")] }
  }
  TestCase {
    id: checks; when: false
    ${poll}
    function run() {
      try {
        var bad = ["wss://h\\"x.invalid/ws", "wss://h\\\\x.invalid/ws"]
        for (var i = 0; i < bad.length; i++) {
          client.configured = true
          client.serverUrl = bad[i]
          client.tokenFile = "/nonexistent/h.token"
          settings.load()
          check(settings.candidateUrl === bad[i], "candidate " + settings.candidateUrl)
          settings.apply(true)
          check(settings.feedback === "The address has a character it cannot have (a quote, backslash or line break).", "feedback " + settings.feedback)
          check(!settings.working, "still working")
        }
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  `, { files: { curl: '#!/bin/sh\necho ran >> "$(dirname "$0")/curl-ran"\nprintf 200\n' } });
});
