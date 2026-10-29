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
        client.handleLine(JSON.stringify({type:"history", messages:[
          {id:"h1", role:"user", text:"Earlier question", at: t0 - 5 * 60000},
          {id:"h2", role:"assistant", text:"Earlier answer", at: t0 - 3 * 3600000},
          {id:"h3", role:"user", text:"From an old daemon"}]}))
        client.handleLine(JSON.stringify({type:"message_delta", messageId:"r", delta:"Hi"}))
        client.handleLine(JSON.stringify({type:"message_done", messageId:"r", text:"Hi", at: twoDaysAgo}))
        client.handleLine(JSON.stringify({type:"message_delta", messageId:"s", delta:"Plain"}))
        client.handleLine(JSON.stringify({type:"message_done", messageId:"s", text:"Plain"}))
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
        client.handleLine(JSON.stringify({type:"upload_done", requestId:"r", files:[{path: file("shot.png"), uploadId:"${OWN}", name:"shot.png", size:120, mime:"image/png"}]}))
        client.handleLine(history)
        client.handleLine(history)
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
        client.handleLine(JSON.stringify({type:"attachment_cached", requestId: mac.requestId, uploadId:"${ID}", name:"from-mac.png", path: file("from-mac.png"), mime:"image/png"}))
        client.handleLine(JSON.stringify({type:"attachment_error", requestId: fetchOf("gone.webp")[0].requestId, uploadId:"${GONE}", name:"gone.webp", code:"not_found"}))
        client.handleLine(JSON.stringify({type:"attachment_error", requestId: fetchOf("flaky.jpg")[0].requestId, uploadId:"${FLAKY}", name:"flaky.jpg", code:"network"}))
        // The cached file decodes asynchronously.
        var thumbs = []
        settle(function() {
          thumbs = find(row(0), "attachmentThumb")
          if (thumbs.length !== 1) throw Error("thumbnail " + thumbs.length)
          var image = find(thumbs[0], "attachmentThumbImage")[0]
          if (image.status !== Image.Ready || image.sourceSize.width !== 240) throw Error("thumbnail image " + image.status)
        })
        find(thumbs[0], "attachmentThumbHit")[0].clicked(null)
        if (!client.viewerImage || client.viewerImage.path !== file("from-mac.png")) throw Error("viewer " + JSON.stringify(client.viewerImage))
        client.closeImage()
        if (note(2, "gone.webp") !== "preview unavailable · not found") throw Error("failure note " + note(2, "gone.webp"))
        if (note(3, "flaky.jpg") !== "preview unavailable · download failed") throw Error("network note " + note(3, "flaky.jpg"))
        if (fetches().length !== 3) throw Error("refetched " + fetches().length)
        // A reconnect retries network failures once its history arrives; not_found stays.
        client.handleLine(JSON.stringify({type:"ready"}))
        client.handleLine(history)
        if (fetchOf("flaky.jpg").length !== 2 || fetchOf("gone.webp").length !== 1 || fetchOf("from-mac.png").length !== 1) throw Error("retry " + JSON.stringify(fetches()))
        find(row(0), "attachmentOpen")[0].clicked()
        var pdf = fetchOf("report.pdf")
        if (pdf.length !== 1 || pdf[0].uploadId !== "${ID}") throw Error("open did not fetch " + JSON.stringify(pdf))
        client.handleLine(JSON.stringify({type:"attachment_cached", requestId: pdf[0].requestId, uploadId:"${ID}", name:"report.pdf", path: file("report.pdf"), mime:"application/pdf"}))
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
        if (opened !== file("report.pdf")) throw Error("opened " + JSON.stringify(opened))
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 150; running: true; onTriggered: checks.run() }
  `, {files: {
    'shot.png': png(),
    'from-mac.png': png(6, 4),
    'report.pdf': '%PDF-1.4\n',
    'open': '#!/bin/sh\nprintf "%s" "$1" > "$(dirname "$0")/opened"\n',
  }});
});
