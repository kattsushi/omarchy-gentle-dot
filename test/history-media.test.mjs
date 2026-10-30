import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { poll, qml } from './composer-harness.test.mjs';

// History times (S14.3) and history images fetched through the bridge (S14.5, daemon contract S14.7).

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

const helpers = `
  function find(item, name, list) {
    list = list || []
    if (item.objectName === name && item.visible) list.push(item)
    for (var i = 0; i < item.children.length; i++) find(item.children[i], name, list)
    return list
  }
  function file(name) { return Qt.resolvedUrl(name).toString().replace("file://", "") }
  function row(index) { return chat.itemAtIndex(index) }
  function times(index) { return find(row(index), "messageTime").map(function(label) { return label.text }) }`;

test('history messages with `at` show their time, the daemon\'s live `at` wins over the receipt time, none without `at`', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false}); function send(obj) { return true } }
  FloatingWindow {
    visible: true; width: 600; height: 900
    Plugin.ChatView { id: chat; anchors.fill: parent; client: client; model: client.messages }
  }
  ${helpers}
  property real t0: 0
  property real twoDaysAgo: 0
  TestCase {
    id: checks; name: "HistoryTimes"; when: false
    ${poll}
    function run() {
      try {
        t0 = Date.now()
        twoDaysAgo = t0 - 2 * 86400000
        client.now = t0
        client.handleDaemon(({type:"history", messages:[
          {id:"h1", role:"user", text:"Earlier question", at: t0 - 5 * 60000},
          {id:"h2", role:"assistant", text:"Earlier answer", at: t0 - 3 * 3600000},
          {id:"h3", role:"user", text:"From an old daemon"}]}))
        client.handleDaemon(({type:"message_delta", messageId:"r", delta:"Hi"}))
        client.handleDaemon(({type:"message_done", messageId:"r", text:"Hi", at: twoDaysAgo}))
        client.handleDaemon(({type:"message_delta", messageId:"s", delta:"Plain"}))
        client.handleDaemon(({type:"message_done", messageId:"s", text:"Plain"}))
        // The list creates its delegates when it lays out.
        settle(function() {
          if (!row(4)) throw Error("rows not laid out")
          if (times(0).join() !== "5 min ago") throw Error("history user time " + times(0))
          if (times(1).join() !== "3 h ago") throw Error("history reply time " + times(1))
        })
        if (times(2).length !== 0) throw Error("time invented for history without at " + times(2))
        if (client.messages.get(3).at !== twoDaysAgo) throw Error("receipt time kept over the daemon's at")
        var date = new Date(twoDaysAgo)
        var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
        var expected = months[date.getMonth()] + " " + date.getDate()
        if (times(3).join().indexOf(expected) !== 0) throw Error("live at not shown " + times(3) + " vs " + expected)
        if (times(4).join() !== "just now") throw Error("receipt time without at " + times(4))
        console.log("QML_PASS"); Qt.quit()
      } catch(e) { console.log("QML_FAIL", String(e)); Qt.exit(1) }
    }
  }
  Timer { interval: 150; running: true; onTriggered: checks.run() }
  `);
});

const ID = 'u_AbCdEfGhIjKlMnOpQr-_12';
const OWN = 'u_OwnOwnOwnOwnOwnOwnOw-_';
const GONE = 'u_GoneGoneGoneGoneGone_1';
const FLAKY = 'u_FlakyFlakyFlakyFlaky_1';

test('history images with an uploadId are fetched once and shown as thumbnails; other files only on Open; failures keep the chip with a reason', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false}); openCommand: [file("open")]
    property var sent: []; function send(obj) { sent = sent.concat([obj]); return true } }
  FloatingWindow {
    visible: true; width: 600; height: 1000
    Plugin.ChatView { id: chat; anchors.fill: parent; client: client; model: client.messages }
  }
  ${helpers}
  function fetches() { return client.sent.filter(function(m) { return m.type === "fetch_attachment" }) }
  // Where the bridge caches a fetched file; the client takes no other path for it (S22.1).
  function cached(name) { return Quickshell.env("XDG_RUNTIME_DIR") + "/omarchy-gentle-dot/cache/${ID}/" + name }
  function fetchOf(name) { return fetches().filter(function(m) { return m.name === name }) }
  function chip(index, name) {
    return find(row(index), "attachmentChip").filter(function(c) { return find(c, "chipName")[0].text === name })[0]
  }
  function note(index, name) { var notes = find(chip(index, name), "chipNote"); return notes.length ? notes[0].text : "" }
  property string history: JSON.stringify({type:"history", messages:[
    {id:"m1", role:"user", text:"From the Mac", attachments:[
      {name:"from-mac.png", size:70, mime:"image/png", uploadId:"${ID}"},
      {name:"report.pdf", size:2048, mime:"application/pdf", uploadId:"${ID}"},
      {name:"old.png", size:9, mime:"image/png"}]},
    {id:"m2", role:"user", text:"Mine", attachments:[{name:"shot.png", size:120, mime:"image/png", uploadId:"${OWN}"}]},
    {id:"m3", role:"user", text:"Gone", attachments:[{name:"gone.webp", size:5, mime:"image/webp", uploadId:"${GONE}"}]},
    {id:"m4", role:"user", text:"Flaky", attachments:[{name:"flaky.jpg", size:5, mime:"image/jpeg", uploadId:"${FLAKY}"}]}]})
  property var probe: Qt.createQmlObject("import Quickshell.Io; Process { id: proc; property alias out: collector.text; property bool done: false; stdout: StdioCollector { id: collector; waitForEnd: true; onStreamFinished: proc.done = true } }", chat)
  TestCase {
    id: checks; name: "HistoryImages"; when: false
    ${poll}
    function run() {
      try {
        client.connection = "open"; client.ready = true
        client.attachments = [{path: file("shot.png"), name:"shot.png", size:120, mime:"image/png"}]
        client.submitDraft()
        client.handleBridge(({type:"upload_done", requestId: client.sent[0].requestId, files:[{path: file("shot.png"), uploadId:"${OWN}", name:"shot.png", size:120, mime:"image/png"}]}))
        client.handleDaemon(JSON.parse(history))
        client.handleDaemon(JSON.parse(history))
        // Fetches are asked for as the list lays out its rows.
        settle(function() {
          if (!row(3)) throw Error("rows not laid out")
          if (note(0, "from-mac.png") !== "loading preview…") throw Error("loading note " + note(0, "from-mac.png"))
          if (find(row(1), "attachmentThumb").length !== 1) throw Error("own upload not a local thumbnail")
        })
        var list = fetches()
        if (list.length !== 3) throw Error("fetches " + JSON.stringify(list))
        var mac = fetchOf("from-mac.png")[0]
        if (!mac || mac.uploadId !== "${ID}" || typeof mac.requestId !== "string" || !mac.requestId) throw Error("from-mac fetch " + JSON.stringify(mac))
        if (fetchOf("gone.webp").length !== 1 || fetchOf("flaky.jpg").length !== 1) throw Error("other image fetches")
        if (fetchOf("report.pdf").length || fetchOf("old.png").length || fetchOf("shot.png").length) throw Error("fetched what it should not")
        if (note(0, "from-mac.png") !== "loading preview…") throw Error("loading note " + note(0, "from-mac.png"))
        if (note(0, "old.png") !== "preview unavailable") throw Error("old daemon note " + note(0, "old.png"))
        if (note(0, "report.pdf") !== "") throw Error("pdf note " + note(0, "report.pdf"))
        var opens = find(row(0), "attachmentOpen")
        if (opens.length !== 1 || opens[0].tooltipText !== "Open report.pdf") throw Error("open buttons " + opens.length)
        if (find(row(1), "attachmentThumb").length !== 1) throw Error("own upload not a local thumbnail")
        client.handleBridge(({type:"attachment_cached", requestId: mac.requestId, uploadId:"${ID}", name:"from-mac.png", path: cached("from-mac.png"), mime:"image/png"}))
        client.handleBridge(({type:"attachment_error", requestId: fetchOf("gone.webp")[0].requestId, uploadId:"${GONE}", name:"gone.webp", code:"not_found"}))
        client.handleBridge(({type:"attachment_error", requestId: fetchOf("flaky.jpg")[0].requestId, uploadId:"${FLAKY}", name:"flaky.jpg", code:"network"}))
        // The cached file decodes asynchronously.
        var thumbs = []
        settle(function() {
          thumbs = find(row(0), "attachmentThumb")
          if (thumbs.length !== 1) throw Error("thumbnail " + thumbs.length)
          var image = find(thumbs[0], "attachmentThumbImage")[0]
          if (image.status !== Image.Ready || image.sourceSize.width !== 240) throw Error("thumbnail image " + image.status)
        })
        find(thumbs[0], "attachmentThumbHit")[0].clicked(null)
        if (!client.viewerImage || client.viewerImage.path !== cached("from-mac.png")) throw Error("viewer " + JSON.stringify(client.viewerImage))
        client.closeImage()
        if (note(2, "gone.webp") !== "preview unavailable · not found") throw Error("failure note " + note(2, "gone.webp"))
        if (note(3, "flaky.jpg") !== "preview unavailable · download failed") throw Error("network note " + note(3, "flaky.jpg"))
        if (fetches().length !== 3) throw Error("refetched " + fetches().length)
        // A reconnect retries network failures once its history arrives; not_found stays.
        client.handleDaemon(({type:"ready"}))
        client.handleDaemon(JSON.parse(history))
        if (fetchOf("flaky.jpg").length !== 2 || fetchOf("gone.webp").length !== 1 || fetchOf("from-mac.png").length !== 1) throw Error("retry " + JSON.stringify(fetches()))
        find(row(0), "attachmentOpen")[0].clicked()
        var pdf = fetchOf("report.pdf")
        if (pdf.length !== 1 || pdf[0].uploadId !== "${ID}") throw Error("open did not fetch " + JSON.stringify(pdf))
        client.handleBridge(({type:"attachment_cached", requestId: pdf[0].requestId, uploadId:"${ID}", name:"report.pdf", path: cached("report.pdf"), mime:"application/pdf"}))
        // The open command is a process that writes what it was given to "opened".
        var opened = ""
        until(function() {
          probe.done = false
          probe.command = ["cat", file("opened")]
          probe.running = true
          until(function() { return probe.done }, 10000, "cat finishes")
          opened = probe.out
          return opened !== ""
        }, 10000, "the open command ran")
        if (opened !== cached("report.pdf")) throw Error("opened " + JSON.stringify(opened))
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 150; running: true; onTriggered: checks.run() }
  `, {files: {
    'shot.png': png(),
    [`omarchy-gentle-dot/cache/${ID}/from-mac.png`]: png(6, 4),
    [`omarchy-gentle-dot/cache/${ID}/report.pdf`]: '%PDF-1.4\n',
    'open': '#!/bin/sh\nprintf "%s" "$1" > "$(dirname "$0")/opened"\n',
  }});
});

// S22.1 should-fix: a history load fetches at most 20 previews (the newest); the others wait for
// a click, so a daemon cannot make the bridge download hundreds of files at once.
test('a history load auto-fetches at most 20 image previews, newest first; the rest load on click', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false})
    property var sent: []; function send(obj) { sent = sent.concat([obj]); return true } }
  FloatingWindow {
    visible: true; width: 600; height: 1000
    Plugin.ChatView { id: chat; anchors.fill: parent; client: client; model: client.messages }
  }
  ${helpers}
  function fetches() { return client.sent.filter(function(m) { return m.type === "fetch_attachment" }) }
  function id(i) { return "u_Many" + ("000000000000000000" + i).slice(-18) }
  TestCase {
    id: checks; when: false
    ${poll}
    function run() {
      try {
        var messages = []
        for (var i = 0; i < 25; i++)
          messages.push({id: "m" + i, role: "user", text: "", attachments: [{name: "p.png", size: 9, mime: "image/png", uploadId: id(i)}]})
        client.handleDaemon({type: "history", messages: messages})
        var list = fetches()
        if (list.length !== 20) throw Error("fetches " + list.length)
        for (var j = 0; j < 20; j++) if (!list.some(function(m) { return m.uploadId === id(24 - j) })) throw Error("newest not fetched " + (24 - j))
        if (list.some(function(m) { return m.uploadId === id(0) })) throw Error("oldest fetched")
        var first = JSON.parse(client.messages.get(0).attachments)[0]
        if (!first.deferred || first.loading) throw Error("row " + JSON.stringify(first))
        // A live message from another client is not held back by the history's budget.
        client.handleDaemon({type: "user_message", messageId: "live", text: "", attachments: [{name: "q.png", size: 9, mime: "image/png", uploadId: id(99)}]})
        if (fetches().length !== 21) throw Error("live image not fetched " + fetches().length)
        // The oldest row offers to load its preview; its click fetches the preview, it opens nothing.
        chat.positionViewAtBeginning()
        var button = null
        settle(function() {
          var first = row(0)
          check(first, "row 0")
          var notes = find(first, "chipNote")
          check(notes.length === 1 && notes[0].text === "preview not loaded", "note " + (notes.length ? notes[0].text : "none"))
          button = find(first, "attachmentOpen")[0]
          check(button && button.tooltipText === "Load preview of p.png", "load button")
        })
        button.clicked()
        var asked = fetches().filter(function(m) { return m.uploadId === id(0) })
        if (asked.length !== 1 || client.pendingOpens[id(0) + "/p.png"]) throw Error("click " + JSON.stringify(asked) + " " + JSON.stringify(client.pendingOpens))
        // The same history again asks for nothing new: what it shows already used its budget.
        client.handleDaemon({type: "history", messages: messages})
        if (fetches().length !== 22) throw Error("refetched " + fetches().length)
        if (!JSON.parse(client.messages.get(1).attachments)[0].deferred) throw Error("repeat history fetched more")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 150; running: true; onTriggered: checks.run() }
  `);
});

// S22.1 advisory: Open hands a file to xdg-open (its path on that command line, on the user's
// click). Only images, PDFs and plain text whose bytes match their name open; anything else (a
// cached .desktop file, a script) is left where it is, with its path to copy.
test('Open runs xdg-open only for images, PDFs and plain text; other files show where they are saved, with Copy path', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false}); openCommand: [file("open")]; clipboardCommand: [file("copy")]
    property var sent: []; function send(obj) { sent = sent.concat([obj]); return true } }
  FloatingWindow {
    visible: true; width: 600; height: 1000
    Plugin.ChatView { id: chat; anchors.fill: parent; client: client; model: client.messages }
  }
  ${helpers}
  function fetchOf(name) { return client.sent.filter(function(m) { return m.type === "fetch_attachment" && m.name === name }) }
  function cached(name) { return Quickshell.env("XDG_RUNTIME_DIR") + "/omarchy-gentle-dot/cache/${ID}/" + name }
  property var probe: Qt.createQmlObject("import Quickshell.Io; Process { id: proc; property alias out: collector.text; property bool done: false; stdout: StdioCollector { id: collector; waitForEnd: true; onStreamFinished: proc.done = true } }", chat)
  function read(name) {
    probe.done = false
    probe.command = ["sh", "-c", "cat -- \\"$1\\" 2>/dev/null; true", "sh", file(name)]
    probe.running = true
    checks.until(function() { return probe.done }, 10000, "cat finishes")
    return probe.out
  }
  TestCase {
    id: checks; when: false
    ${poll}
    function run() {
      try {
        client.handleDaemon({type:"history", messages:[{id:"m", role:"user", text:"", attachments:[
          {name:"tool.desktop", size:40, mime:"text/plain", uploadId:"${ID}"},
          {name:"fake.pdf", size:40, mime:"application/pdf", uploadId:"${ID}"},
          {name:"notes.txt", size:5, mime:"text/plain", uploadId:"${ID}"}]}]})
        var opens = []
        settle(function() { opens = find(row(0), "attachmentOpen"); check(opens.length === 3, "open buttons " + opens.length) })
        for (var i = 0; i < 3; i++) opens[i].clicked()
        // The bridge's own type, from the bytes: a .desktop file, a "pdf" that is not one, real text.
        client.handleBridge({type:"attachment_cached", requestId: fetchOf("tool.desktop")[0].requestId, uploadId:"${ID}", name:"tool.desktop", path: cached("tool.desktop"), mime:"application/octet-stream"})
        client.handleBridge({type:"attachment_cached", requestId: fetchOf("fake.pdf")[0].requestId, uploadId:"${ID}", name:"fake.pdf", path: cached("fake.pdf"), mime:"application/octet-stream"})
        check(client.notice.indexOf("Saved to " + cached("fake.pdf")) === 0, "notice " + client.notice)
        client.handleBridge({type:"attachment_cached", requestId: fetchOf("notes.txt")[0].requestId, uploadId:"${ID}", name:"notes.txt", path: cached("notes.txt"), mime:"text/plain"})
        var opened = ""
        until(function() { opened = read("opened"); return opened !== "" }, 10000, "notes.txt opened")
        check(opened === cached("notes.txt") + "\\n", "opened " + JSON.stringify(opened))
        wait(300)
        check(read("opened") === cached("notes.txt") + "\\n", "opened more than notes.txt: " + read("opened"))
        // The chips now offer the saved files' paths instead of Open.
        var copies = []
        settle(function() { copies = find(row(0), "attachmentCopyPath"); check(copies.length === 2, "copy path buttons " + copies.length) })
        check(find(row(0), "attachmentOpen").length === 1, "open buttons left " + find(row(0), "attachmentOpen").length)
        check(client.openFile(cached("tool.desktop")) === false, "openFile ran a .desktop file")
        copies[0].clicked()
        var copied = ""
        until(function() { copied = read("copied"); return copied !== "" }, 10000, "path copied")
        check(copied === cached("tool.desktop"), "copied " + JSON.stringify(copied))
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 150; running: true; onTriggered: checks.run() }
  `, {files: {
    [`omarchy-gentle-dot/cache/${ID}/tool.desktop`]: '[Desktop Entry]\nType=Application\nExec=true\n',
    [`omarchy-gentle-dot/cache/${ID}/fake.pdf`]: '#!/bin/sh\ntrue\n',
    [`omarchy-gentle-dot/cache/${ID}/notes.txt`]: 'hello',
    'open': '#!/bin/sh\nprintf "%s\\n" "$1" >> "$(dirname "$0")/opened"\n',
    'copy': '#!/bin/sh\ncat > "$(dirname "$0")/copied"\n',
  }});
});
