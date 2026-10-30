import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { poll, qml } from './composer-harness.test.mjs';
import {
  ATTACHMENT_LIMITS, addWithinLimits, allowedImageUrl, autoFetched, downloadUrl, fileUrl, formatSize, isImage, localPathOf,
  inertMarkdown, markdownParts, markdownText, mimeFor, safeToOpen, uploadEndpoint, validStoredName, validUploadId,
} from '../bridge/attachments.mjs';

// A real width x height PNG, so Qt can decode thumbnails in the headless harness.
export function png(width = 4, height = 3) {
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
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([240, 117, 168], y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const MB = 1024 * 1024;

test('attachment limits: files per message, bytes per file and per message, duplicates and unreadable files', () => {
  assert.deepEqual(ATTACHMENT_LIMITS, { fileBytes: 25 * MB, messageBytes: 50 * MB, files: 10 });
  const a = { path: '/a.png', name: 'a.png', size: 10, mime: 'image/png' };
  let result = addWithinLimits([], [a, a, { path: '/gone', name: 'gone', error: 'file not found' }]);
  assert.deepEqual(result.list, [a]);
  assert.deepEqual(result.errors, ['gone cannot be attached: file not found']);
  result = addWithinLimits([a], [{ path: '/big.bin', name: 'big.bin', size: 25 * MB + 1, mime: 'application/octet-stream' }]);
  assert.deepEqual(result, { list: [a], errors: ['big.bin is too large: up to 25 MB per file.'] });
  const halves = [1, 2].map(n => ({ path: `/h${n}`, name: `h${n}`, size: 24 * MB, mime: 'x' }));
  result = addWithinLimits([], [...halves, { path: '/h3', name: 'h3', size: 3 * MB, mime: 'x' }]);
  assert.deepEqual(result.list.map(f => f.name), ['h1', 'h2']);
  assert.deepEqual(result.errors, ['h3 does not fit: up to 50 MB per message.']);
  const ten = Array.from({ length: 10 }, (_, n) => ({ path: `/f${n}`, name: `f${n}`, size: 1, mime: 'x' }));
  result = addWithinLimits(ten.slice(0, 9), [ten[9], { path: '/eleven', name: 'eleven', size: 1, mime: 'x' }]);
  assert.equal(result.list.length, 10);
  assert.deepEqual(result.errors, ['Too many files: up to 10 per message.']);
});

test('sizes, types, local paths and the upload endpoint', () => {
  assert.deepEqual([512, 2048, 1.5 * MB, 12.4 * MB].map(formatSize), ['512 B', '2 KB', '1.5 MB', '12 MB']);
  assert.equal(mimeFor('x.bin', png()), 'image/png');
  assert.equal(mimeFor('notes.txt', Buffer.from('hello')), 'text/plain');
  assert.equal(mimeFor('blob', Buffer.from('hello')), 'application/octet-stream');
  assert.ok(isImage('image/png') && isImage('IMAGE/JPEG') && !isImage('application/pdf'));
  assert.equal(localPathOf('file:///tmp/a%20b.png'), '/tmp/a b.png');
  assert.equal(localPathOf('/tmp/x.png'), '/tmp/x.png');
  assert.equal(localPathOf('relative.png'), '');
  assert.equal(uploadEndpoint('ws://127.0.0.1:4317/ws'), 'http://127.0.0.1:4317/upload');
  assert.equal(uploadEndpoint('wss://mac.tail.ts.net/ws'), 'https://mac.tail.ts.net/upload');
  assert.equal(uploadEndpoint('wss://[fd7a::1]:8443/ws'), 'https://[fd7a::1]:8443/upload');
});

test('stored attachments: upload ids, names, download URLs, auto-fetched types and file URLs', () => {
  const id = 'u_AbCdEfGhIjKlMnOpQr-_12';
  assert.ok(validUploadId(id));
  for (const bad of ['u_short', `${id}x`, `../${id}`, `x${id.slice(1)}`, 'u_AbCdEfGhIjKlMnOpQr/_12', '', null, 7]) assert.equal(validUploadId(bad), false, String(bad));
  for (const good of ['shot.png', 'my photo #1 ñ (2).png', 'a'.repeat(120)]) assert.ok(validStoredName(good), good);
  for (const bad of ['', '.', '..', '.env', 'a/b', 'a\\b', 'a\u0000b', 'tab\there', 'a'.repeat(121), null, 3]) assert.equal(validStoredName(bad), false, JSON.stringify(bad));
  assert.equal(downloadUrl('wss://mac.tail.ts.net/ws', id, 'my photo #1 (2).png'), `https://mac.tail.ts.net/upload/${id}/my%20photo%20%231%20(2).png`);
  assert.equal(downloadUrl('ws://127.0.0.1:4317/ws', id, '../x'), '');
  assert.equal(downloadUrl('ws://127.0.0.1:4317/ws', 'u_bad', 'a.png'), '');
  assert.deepEqual(['image/png', 'IMAGE/JPEG', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml', 'application/pdf', ''].map(autoFetched),
    [true, true, true, true, false, false, false, false]);
  assert.equal(fileUrl('/run/user/1000/omarchy-gentle-dot/cache/u_x/a #1?.png'), 'file:///run/user/1000/omarchy-gentle-dot/cache/u_x/a%20%231%3F.png');
});

// S22.1: Markdown comes from the daemon, so a local path or file:// image would let it show (and
// offer to copy or attach) any local file: only https images load.
test('Markdown images: only https becomes an image part; local files, other schemes and raw <img> keep their alt text', () => {
  assert.equal(allowedImageUrl('https://example.com/a.png'), 'https://example.com/a.png');
  for (const bad of ['/home/me/a b.png', 'file:///home/me/a.png', 'file://localhost/etc/x.png', 'http://example.com/a.png',
    'data:image/png;base64,AAAA', 'javascript:x', 'ftp://h/a.png', 'a.png']) assert.equal(allowedImageUrl(bad), '', bad);
  assert.deepEqual(markdownParts('See ![chart](https://example.com/c.png "Title") and ![pixel](http://tracker/p.gif).\n<img src="http://x/y.png"> `![code](/kept)` ![shot](/tmp/s.png) ![key](file:///home/me/.ssh/id.png)'), [
    { type: 'md', text: 'See ' },
    { type: 'image', url: 'https://example.com/c.png', alt: 'chart' },
    { type: 'md', text: ' and pixel.\n `!\u2060[code](/kept)` shot key' },
  ]);
  assert.deepEqual(markdownParts('No images here'), [{ type: 'md', text: 'No images here' }]);
});

// Qt's Markdown renderer also loads images from raw HTML (<img>, background attributes, CSS) and
// reference-style images: none of that may reach it from daemon text. A WORD JOINER after every "<"
// and "![" makes them inert in prose and code alike; the visible text is unchanged.
test('Markdown prose: HTML and leftover image syntax are made inert, whatever the trick; the visible text is unchanged', () => {
  const W = '\u2060';
  const md = (text) => markdownParts(text).map((part) => part.type === 'md' ? part.text : `[image ${part.url}]`).join('');
  assert.equal(md('a < b, use `Vec<T>` and ``a`b`` here'), `a <${W} b, use \`Vec<${W}T>\` and \`\`a\`b\`\` here`);
  assert.equal(md('<im<img>g src="/etc/x.png">'), `<${W}img src="/etc/x.png">`);
  assert.equal(md('<table background="/etc/x.png"><tr><td>x</td></tr></table>'),
    `<${W}table background="/etc/x.png"><${W}tr><${W}td>x<${W}/td><${W}/tr><${W}/table>`);
  assert.equal(md('<p style="background-image: url(/etc/x.png)">x</p>'), `<${W}p style="background-image: url(/etc/x.png)">x<${W}/p>`);
  assert.equal(md('![ref][x]\n\n[x]: /etc/x.png'), `!${W}[ref][x]\n\n[x]: /etc/x.png`);
  // Inside what looks like inline code too.
  assert.equal(md('`<img src=/etc/x.png>` and `![k](/etc/x.png)`'), `\`<${W}img src=/etc/x.png>\` and \`!${W}[k](/etc/x.png)\``);
  assert.equal(md('fine ![k](https://h.example/a.png) <b>'), `fine [image https://h.example/a.png] <${W}b>`);
  assert.equal(markdownText('Approve ![shot](/etc/x.png) <b>now</b>?'), `Approve shot <${W}b>now<${W}/b>?`);
  // Idempotent, and nothing but the joiners is added.
  for (const text of ['a <b> ![x](/y) `c`', '<<!!![[', '']) {
    assert.equal(inertMarkdown(inertMarkdown(text)), inertMarkdown(text));
    assert.equal(inertMarkdown(text).replaceAll(W, ''), text);
  }
  // An https image inside a span md4c does not read as code (it spans lines) is extracted, not sheltered.
  assert.deepEqual(markdownParts('`a\n![k](https://h.example/a.png) b`').map((part) => part.type), ['md', 'image', 'md']);
});

const find = `
  function find(item, name, list) {
    list = list || []
    if (item.objectName === name && item.visible) list.push(item)
    for (var i = 0; i < item.children.length; i++) find(item.children[i], name, list)
    return list
  }
  function file(name) { return Qt.resolvedUrl(name).toString().replace("file://", "") }`;

test('composer: attach icon left of the mic, chips with thumbnail/size/remove, and clear limit errors', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false}); property var sent: []; function send(obj) { sent = sent.concat([obj]); return true } }
  FloatingWindow {
    visible: true; width: 600; height: 500
    Plugin.Composer { id: composer; client: client; width: 500; property int picks: 0; function pickFiles() { picks++ } }
  }
  ${find}
  property var shot: file("shot.png")
  TestCase {
    id: checks; name: "Chips"; when: false
    ${poll}
    function run() {
      try {
        var attach = find(composer, "attachButton")[0], mic = find(composer, "micButton")[0]
        if (!attach || !mic || attach.iconText !== "󰏢" || attach.tooltipText !== "Attach files") throw Error("attach icon")
        if (attach.mapToItem(composer, 0, 0).x >= mic.mapToItem(composer, 0, 0).x) throw Error("attach not left of mic")
        attach.clicked()
        if (composer.picks !== 1) throw Error("picker not opened")
        var height = composer.implicitHeight
        client.addAttachmentPaths([shot, "file://" + encodeURI(file("my notes.txt"))])
        var inspect = client.sent[0]
        if (inspect.type !== "inspect_files" || inspect.paths[0] !== shot || inspect.paths[1] !== file("my notes.txt")) throw Error("inspect " + JSON.stringify(inspect))
        client.handleBridge(({type:"files_inspected", requestId: inspect.requestId, files:[
          {path: shot, name: "shot.png", size: 1572864, mime: "image/png"}, {path: file("my notes.txt"), name: "my notes.txt", size: 5, mime: "text/plain"}]}))
        if (client.attachments.length !== 2) throw Error("not attached")
        // Chips are laid out and the thumbnail decodes asynchronously.
        var chips = []
        settle(function() {
          chips = find(composer, "attachmentChip")
          if (chips.length !== 2) throw Error("chips " + chips.length)
          if (chips[0].mapToItem(composer, 0, 0).y >= find(composer, "micButton")[0].mapToItem(composer, 0, 0).y) throw Error("chips not above the field")
          var thumb = find(chips[0], "chipThumb")[0]
          if (!thumb || thumb.status !== Image.Ready || !thumb.asynchronous) throw Error("thumbnail")
        })
        if (find(chips[1], "chipThumb").length) throw Error("thumbnail for text")
        if (find(chips[0], "chipName")[0].text !== "shot.png" || find(chips[0], "chipSize")[0].text !== "1.5 MB") throw Error("chip text")
        client.addAttachmentPaths(["/big"])
        var big = client.sent[client.sent.length - 1]
        client.handleBridge(({type:"files_inspected", requestId: big.requestId, files:[{path:"/big", name:"big.iso", size: 30 * 1048576, mime:"x"}]}))
        if (client.notice !== "big.iso is too large: up to 25 MB per file." || client.noticeLevel !== "error") throw Error("limit notice " + client.notice)
        if (client.attachments.length !== 2) throw Error("refused file kept")
        find(chips[1], "chipRemove")[0].clicked()
        if (client.attachments.length !== 1 || client.attachments[0].name !== "shot.png") throw Error("remove")
        console.log("QML_PASS"); Qt.quit()
      } catch(e) { console.log("QML_FAIL", String(e)); Qt.exit(1) }
    }
  }
  Timer { interval: 150; running: true; onTriggered: checks.run() }
  `, {files: {'shot.png': png()}});
});

test('sending with files uploads first, keeps the draft until upload_done, and maps uploads to local thumbnails', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false}); property var sent: []; function send(obj) { sent = sent.concat([obj]); return true } }
  FloatingWindow {
    visible: true; width: 600; height: 500
    Plugin.Composer { id: composer; client: client; width: 500 }
  }
  ${find}
  property var shot: file("shot.png")
  TestCase {
    id: checks; name: "Upload"; when: false
    function run() {
      try {
        client.connection = "open"; client.ready = true
        client.attachments = [{path: shot, name: "shot.png", size: 120, mime: "image/png"}, {path: "/tmp/n.txt", name: "n.txt", size: 5, mime: "text/plain"}]
        client.draft = "look"
        composer.forceActiveFocus()
        keyClick(Qt.Key_Return)
        var upload = client.sent[0]
        if (upload.type !== "upload_files" || upload.text !== "look" || upload.paths.join() !== shot + ",/tmp/n.txt" || !/^omarchy-/.test(upload.requestId)) throw Error("upload " + JSON.stringify(upload))
        if (client.draft !== "look" || client.attachments.length !== 2 || !client.uploading) throw Error("cleared too early")
        keyClick(Qt.Key_Return)
        if (client.sent.length !== 1) throw Error("sent twice")
        client.handleBridge(({type:"upload_progress", requestId: upload.requestId, index: 1, count: 2, name: "n.txt", loaded: 2, total: 4}))
        if (client.uploadStatus !== "Uploading n.txt (2/2) · 50%") throw Error("status " + client.uploadStatus)
        client.handleBridge(({type:"upload_error", requestId: upload.requestId, code:"unauthorized", status: 401, message:"Could not upload n.txt: The access key is not valid."}))
        if (client.uploading || client.notice !== "Could not upload n.txt: The access key is not valid." || client.draft !== "look" || client.attachments.length !== 2) throw Error("error handling")
        keyClick(Qt.Key_Return)
        var retry = client.sent[1]
        client.handleBridge(({type:"upload_done", requestId: retry.requestId, files:[
          {path: shot, uploadId:"u_abcdefgh12", name:"shot.png", size:120, mime:"image/png"}, {path:"/tmp/n.txt", uploadId:"u_abcdefgh12", name:"n.txt", size:5, mime:"text/plain"}]}))
        if (client.uploading || client.draft !== "" || client.attachments.length !== 0 || client.uploadStatus !== "") throw Error("not cleared after upload_done")
        if (client.localFiles["u_abcdefgh12/shot.png"] !== shot) throw Error("upload map")
        client.handleDaemon(({type:"user_message", messageId:"m1", text:"look", attachments:[{name:"shot.png", size:120, mime:"image/png"}, {name:"n.txt", size:5, mime:"text/plain"}]}))
        var row = JSON.parse(client.messages.get(0).attachments)
        if (row[0].path !== shot || row[1].path !== "/tmp/n.txt") throw Error("user_message paths " + JSON.stringify(row))
        client.handleDaemon(({type:"history", messages:[{id:"m1", role:"user", text:"look", attachments:[{name:"shot.png", size:120, mime:"image/png"}]}, {id:"h", role:"user", text:"", attachments:[{name:"other.png", size:9, mime:"image/png"}]}]}))
        if (JSON.parse(client.messages.get(0).attachments)[0].path !== shot || JSON.parse(client.messages.get(1).attachments)[0].path !== undefined) throw Error("history paths")
        client.attachments = [{path: shot, name: "shot.png", size: 120, mime: "image/png"}]
        client.draft = ""
        keyClick(Qt.Key_Return)
        if (client.sent[2].type !== "upload_files" || client.sent[2].text !== "") throw Error("files without text")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  `);
});

test('Ctrl+V attaches a clipboard image as a private temp file, and pastes text otherwise', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false}); property var sent: []; function send(obj) { sent = sent.concat([obj]); return true }
    clipboardListCommand: [file("list-types")]; clipboardPasteCommand: [file("paste-image")] }
  FloatingWindow {
    visible: true; width: 600; height: 500
    Plugin.Composer { id: composer; client: client; width: 500; property int textPastes: 0; function pasteText() { textPastes++ } }
    Image { id: pasted; asynchronous: false }
  }
  ${find}
  TestCase {
    id: checks; name: "Paste"; when: false
    ${poll}
    function run() {
      try {
        composer.forceActiveFocus()
        keyClick(Qt.Key_V, Qt.ControlModifier)
        // Listing the clipboard types and saving the image are processes.
        until(function() { return client.sent.length > 0 }, 10000, "the pasted image is attached")
        var inspect = client.sent[0]
        if (!inspect || inspect.type !== "inspect_files") throw Error("no attach " + JSON.stringify(client.sent))
        var dir = Quickshell.env("XDG_RUNTIME_DIR") + "/omarchy-gentle-dot/"
        if (inspect.paths[0].indexOf(dir + "pasted-") !== 0 || !/\\.png$/.test(inspect.paths[0])) throw Error("path " + inspect.paths[0])
        pasted.source = "file://" + inspect.paths[0]
        if (pasted.status !== Image.Ready || pasted.implicitWidth !== 4) throw Error("pasted bytes")
        if (composer.textPastes !== 0) throw Error("text pasted too")
        client.clipboardListCommand = [file("list-text")]
        keyClick(Qt.Key_V, Qt.ControlModifier)
        until(function() { return composer.textPastes > 0 }, 10000, "text clipboard falls back to a text paste")
        if (composer.textPastes !== 1 || client.sent.length !== 1) throw Error("text fallback " + composer.textPastes + " " + JSON.stringify(client.sent))
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  `, {files: {
    'list-types': '#!/bin/sh\nprintf "text/plain\\nimage/png\\n"\n',
    'list-text': '#!/bin/sh\nprintf "text/plain;charset=utf-8\\nUTF8_STRING\\n"\n',
    'paste-image': `#!/bin/sh\n[ "$1" = "--type" ] && [ "$2" = "image/png" ] || exit 3\nbase64 -d <<'EOF'\n${png().toString('base64')}\nEOF\n`,
  }});
});

test('chat: own image attachments show low-quality thumbnails that open the viewer; others show chips, never broken images', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false}); property var sent: []; function send(obj) { sent = sent.concat([obj]); return true } }
  FloatingWindow {
    visible: true; width: 600; height: 900
    Plugin.ChatView { id: chat; width: 600; height: 500; client: client; model: client.messages }
    Plugin.MessageBubble { id: reply; y: 500; width: 500; role: "assistant"; phase: "done"; error: ""; activities: "[]"
      text: "Chart ![local](" + file("shot.png") + ") and ![pixel](http://tracker.example/p.gif) done"
      segments: JSON.stringify([{type:"md", text: text}]) }
  }
  ${find}
  property var shot: file("shot.png")
  TestCase {
    id: checks; name: "OwnImages"; when: false
    ${poll}
    function run() {
      try {
        client.connection = "open"; client.ready = true
        client.attachments = [{path: shot, name:"shot.png", size:120, mime:"image/png"}]
        client.submitDraft()
        client.handleBridge(({type:"upload_done", requestId: client.sent[0].requestId, files:[{path: shot, uploadId:"u_abcdefgh12", name:"shot.png", size:120, mime:"image/png"}]}))
        client.handleDaemon(({type:"history", messages:[{id:"m", role:"user", text:"", attachments:[
          {name:"shot.png", size:120, mime:"image/png"}, {name:"from-mac.png", size:2048, mime:"image/png"}, {name:"notes.txt", size:5, mime:"text/plain"}]}]}))
        // The list lays out its delegates and the thumbnails decode asynchronously.
        var thumbs = [], chips = []
        settle(function() {
          thumbs = find(chat, "attachmentThumb")
          if (thumbs.length !== 1) throw Error("thumbs " + thumbs.length)
          var image = find(thumbs[0], "attachmentThumbImage")[0]
          if (image.status !== Image.Ready || image.sourceSize.width !== 240 || !image.asynchronous || !image.cache) throw Error("thumbnail image " + image.sourceSize.width)
          chips = find(chat, "attachmentChip")
          if (chips.length !== 2) throw Error("chips " + chips.length)
          // A local Markdown image is daemon text naming a local file: only its alt text (S22.1).
          if (find(reply, "markdownImage").length !== 0) throw Error("local markdown image loaded")
        })
        if (find(chips[0], "chipNote")[0].text !== "preview unavailable") throw Error("no preview note")
        if (find(chips[1], "chipNote").length !== 0) throw Error("note on a text file")
        if (find(chat, "userText").length !== 0) throw Error("empty text bubble shown")
        find(thumbs[0], "attachmentThumbHit")[0].clicked(null)
        if (!client.viewerImage || client.viewerImage.path !== shot || client.viewerImage.mime !== "image/png") throw Error("viewer " + JSON.stringify(client.viewerImage))
        var prose = find(reply, "proseText").map(function(item) { return item.text }).join("|")
        if (/!\\[|tracker|shot\\.png/.test(prose) || !/pixel/.test(prose) || !/local/.test(prose)) throw Error("prose " + prose)
        console.log("QML_PASS"); Qt.quit()
      } catch(e) { console.log("QML_FAIL", String(e)); Qt.exit(1) }
    }
  }
  Timer { interval: 150; running: true; onTriggered: checks.run() }
  `, {files: {'shot.png': png()}});
});

test('image viewer: original resolution scaled to fit, copy image with its type, attach back to the composer, Escape closes', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false}); property var sent: []; function send(obj) { sent = sent.concat([obj]); return true }
    imageCopyCommand: [file("copy-image")] }
  FloatingWindow {
    visible: true; width: 800; height: 600
    Plugin.ImageViewer { id: viewer; anchors.fill: parent; client: client }
  }
  ${find}
  property var shot: file("shot.png")
  // The first result of the copy, taken as it happens (it resets to idle after about 1.5 s).
  property string copyResult: ""
  Connections { target: viewer; function onCopyStateChanged() { if (viewer.copyState !== "idle" && !copyResult) copyResult = viewer.copyState } }
  TestCase {
    id: checks; name: "Viewer"; when: false
    ${poll}
    function run() {
      try {
        // A file the panel knows: one waiting in the composer.
        client.attachments = [{path: shot, name: "shot.png", size: 120, mime: "image/png"}]
        client.openImage({path: shot, name: "shot.png", mime: "image/png"})
        settle(function() {
          var image = find(viewer, "viewerImage")[0]
          if (!image || image.status !== Image.Ready || image.sourceSize.width !== 4 || image.paintedWidth < 100) throw Error("original image " + (image && image.paintedWidth))
        })
        if (find(viewer, "viewerName")[0].text !== "shot.png") throw Error("name")
        find(viewer, "viewerCopy")[0].clicked()
        // The copy command is a process.
        until(function() { return copyResult !== "" }, 10000, "the copy command finishes")
        if (copyResult !== "copied") throw Error("copy " + copyResult)
        find(viewer, "viewerAttach")[0].clicked()
        if (client.sent[0].type !== "inspect_files" || client.sent[0].paths[0] !== shot) throw Error("attach back")
        if (client.viewerImage !== null) throw Error("viewer stayed open after attach")
        client.openImage({url: "file://" + shot, name: "local URL", mime: ""})
        if (client.viewerImage !== null) throw Error("viewer opened a file URL")
        client.openImage({url: "https://example.invalid/remote.png", name: "remote", mime: ""})
        if (!client.viewerImage || client.viewerImage.path !== "") throw Error("https image " + JSON.stringify(client.viewerImage))
        if (find(viewer, "viewerCopy").length || find(viewer, "viewerAttach").length) throw Error("actions on a remote image")
        viewer.forceActiveFocus()
        keyClick(Qt.Key_Escape)
        if (client.viewerImage !== null) throw Error("escape")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  `, {files: {
    'shot.png': png(),
    'copy-image': `#!/bin/sh\n[ "$1" = "--type" ] && [ "$2" = "image/png" ] || exit 3\n[ "$(base64 -w0)" = "${png().toString('base64')}" ] || exit 4\n`,
  }});
});

const NOT_LOCAL = 'Only files from this computer can be attached. Save it first, then drop the file.';

test('one drop target: the panel content holds the only DropArea (DropOverlay), the composer has none', async () => {
  const { readFile } = await import('node:fs/promises');
  const composer = await readFile(new URL('../Composer.qml', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../Panel.qml', import.meta.url), 'utf8');
  assert.doesNotMatch(composer, /DropArea\s*\{/);
  assert.doesNotMatch(panel, /DropArea\s*\{/);
  assert.equal(panel.match(/\bDropOverlay\s*\{/g)?.length, 1);
  // Inside the reparented content (popup, pinned panel and detached window alike).
  assert.ok(panel.indexOf('DropOverlay {') > panel.indexOf('PanelKeyCatcher {'));
});

test('drag and drop: highlight while dragging, local files attach, other URLs only show why, text becomes a private .txt', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false}); property var sent: []; function send(obj) { sent = sent.concat([obj]); return true } }
  FloatingWindow {
    visible: true; width: 600; height: 600
    Plugin.Composer { id: composer; client: client; width: 500; y: 450 }
    Plugin.DropOverlay { id: overlay; client: client; width: 600; height: 400 }
    Item { id: dragger; x: 500; y: 500; width: 10; height: 10; Drag.hotSpot.x: 5; Drag.hotSpot.y: 5; Drag.keys: ["text/uri-list"] }
  }
  ${find}
  property var shot: file("shot.png")
  property var notes: file("my notes.txt")
  property string dropped: "  hola\\nmundo ñ 🌹 \\n"
  function fakeDrop(urls, text) {
    return {hasUrls: urls.length > 0, urls: urls, hasText: text !== undefined, text: text || "", action: Qt.IgnoreAction,
      accepted: false, accept: function(action) { this.accepted = true; this.action = action }}
  }
  function card() { return find(overlay, "dropOverlayCard")[0] }
  // The harness imports no Quickshell.Io: create the probe at run time.
  property var probe: Qt.createQmlObject("import Quickshell.Io; Process { id: proc; property alias out: collector.text; property bool done: false; stdout: StdioCollector { id: collector; waitForEnd: true; onStreamFinished: proc.done = true } }", overlay)
  TestCase {
    id: checks; name: "Drop"; when: false
    ${poll}
    function run() {
      try {
        if (card()) throw Error("overlay shown before any drag")
        // A real (internal) Qt Quick drag over the DropArea: enter shows, exit hides, drop hides.
        // Drag moves are delivered as queued events.
        dragger.Drag.active = true
        dragger.x = 100; dragger.y = 100
        until(function() { return overlay.dragging && card() }, 5000, "overlay not shown on enter")
        if (find(overlay, "dropOverlayLabel")[0].text !== "Drop to attach") throw Error("label")
        dragger.x = 500; dragger.y = 500
        until(function() { return !overlay.dragging && !card() }, 5000, "overlay still shown after exit")
        dragger.x = 100; dragger.y = 100
        until(function() { return card() }, 5000, "overlay not shown on re-enter")
        dragger.Drag.drop()
        dragger.Drag.active = false
        until(function() { return !overlay.dragging && !card() }, 5000, "overlay still shown after drop")
        if (client.sent.length) throw Error("an internal drag without data attached something")
        var none = fakeDrop([], undefined)
        overlay.enter(none)
        if (none.accepted || overlay.dragging) throw Error("accepted a drag with neither files nor text")
        var text = fakeDrop([], "x")
        overlay.enter(text)
        if (!text.accepted || !overlay.dragging) throw Error("refused a text drag")
        overlay.exit()
        var charset = {hasUrls: false, hasText: false, keys: ["text/plain;charset=utf-8"], accepted: false, accept: function() { this.accepted = true }}
        overlay.enter(charset)
        if (!charset.accepted || !overlay.dragging) throw Error("refused a text/plain;charset=utf-8 drag")
        overlay.exit()
        var other = {hasUrls: false, hasText: false, keys: ["application/x-color"], accepted: true, accept: function() { this.accepted = true }}
        overlay.enter(other)
        if (other.accepted || overlay.dragging) throw Error("accepted an unrelated drag")

        // Local files of any kind: one inspect, then chips as usual.
        var files = fakeDrop([Qt.url("file://" + shot), "file://" + encodeURI(notes)], "ignored when there are files")
        overlay.drop(files)
        if (!files.accepted || files.action !== Qt.CopyAction) throw Error("drop not accepted")
        var inspect = client.sent[0]
        if (client.sent.length !== 1 || inspect.type !== "inspect_files" || inspect.paths.join("|") !== shot + "|" + notes) throw Error("inspect " + JSON.stringify(client.sent))
        if (client.notice !== "") throw Error("notice for local files " + client.notice)
        client.handleBridge(({type:"files_inspected", requestId: inspect.requestId, files:[
          {path: shot, name: "shot.png", size: 120, mime: "image/png"}, {path: notes, name: "my notes.txt", size: 5, mime: "text/plain"}]}))
        if (find(composer, "attachmentChip").length !== 2) throw Error("chips " + find(composer, "attachmentChip").length)

        // Mixed: the local file attaches, the https image is refused with the reason.
        overlay.drop(fakeDrop(["https://example.com/cat.png", "file:///tmp/report.pdf"], "https://example.com/cat.png"))
        if (client.sent.length !== 2 || client.sent[1].paths.join("|") !== "/tmp/report.pdf") throw Error("mixed " + JSON.stringify(client.sent[1]))
        if (client.notice !== "${NOT_LOCAL}" || client.noticeLevel !== "warning") throw Error("mixed notice " + client.notice)

        // Nothing local: no inspect, only the notice.
        client.notice = ""
        overlay.drop(fakeDrop(["https://example.com/cat.png", "data:image/png;base64,AAAA"], "https://example.com/cat.png"))
        if (client.sent.length !== 2) throw Error("non-local URLs were inspected")
        if (client.notice !== "${NOT_LOCAL}") throw Error("remote notice " + client.notice)
        client.notice = ""
        if (client.addAttachmentPaths(["http://example.com/a.txt"]) !== false || client.notice !== "${NOT_LOCAL}") throw Error("addAttachmentPaths silent")
        client.notice = ""
        if (client.addAttachmentPaths([]) !== false || client.notice !== "") throw Error("notice without values")

        // Whitespace-only text is ignored; real text is saved and attached.
        client.attachments = []
        overlay.drop(fakeDrop([], " \\n\\t "))
        overlay.drop(fakeDrop([], dropped))
        if (overlay.dragging) throw Error("overlay shown after a text drop")
        // The text is saved to a file before it is attached.
        until(function() { return client.sent.length >= 3 }, 10000, "text drop not attached")
        if (client.sent.length !== 3) throw Error("text drop not attached " + JSON.stringify(client.sent))
        var path = client.sent[2].paths[0]
        var dir = Quickshell.env("XDG_RUNTIME_DIR") + "/omarchy-gentle-dot/"
        if (client.sent[2].type !== "inspect_files" || path.indexOf(dir) !== 0 || !/^dropped-text-\\d+\\.txt$/.test(path.slice(dir.length))) throw Error("path " + path)
        probe.command = ["sh", "-c", "stat -c %a -- \\"$1\\" \\"$2\\" && cat -- \\"$2\\"", "sh", dir, path]
        probe.running = true
        until(function() { return probe.done }, 10000, "the file check finishes")
        var expected = "700\\n600\\n" + dropped
        if (probe.out !== expected) throw Error("file " + JSON.stringify(probe.out))
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 150; running: true; onTriggered: checks.run() }
  `, {files: {'shot.png': png()}});
});

test('S22.1: code spans md4c will not see (blank line, any newline) never shelter images or HTML', () => {
  const inputs = ['`\n\n![x](file:///tmp/s.png)\n\n`', '`\n\n![x](/tmp/s.png)\n\n`', 'a `x\n\n![x](/tmp/s.png)\n\ny` b',
    '`![x](/tmp/s.png)\n`', '`\n\n<img src="file:///tmp/s.png">\n\n`',
    // Pieces joined back together must not recreate "![" at their boundary.
    '![!](x)[y](/tmp/s.png)', '!![[z](x)](/tmp/s.png)', '!![[z](https://h.example/a.png)](/tmp/s.png)'];
  for (const input of inputs) {
    for (const part of markdownParts(input)) {
      if (part.type !== 'md') continue;
      assert.doesNotMatch(part.text, /!\[/, JSON.stringify(input));
      assert.doesNotMatch(part.text, /<img/i, JSON.stringify(input));
    }
    assert.doesNotMatch(markdownText(input), /!\[|<img/i, JSON.stringify(input));
  }
});

// md4c splits a GFM table row at its pipes before it looks for code spans, so a backtick pair
// across cells is no code span there.
test('S22.1: a backtick pair across GFM table cells never shelters an image', () => {
  const table = '| a | b | c |\n| - | - | - |\n| `x | ![i](/tmp/s.png) | y` |';
  for (const part of markdownParts(table)) if (part.type === 'md') assert.doesNotMatch(part.text, /!\[|<img/i);
  assert.doesNotMatch(markdownText(table), /!\[|<img/i);
  assert.doesNotMatch(markdownText('| `x | <img src="/tmp/s.png"> | y` |'), /<img/i);
});

test('safeToOpen: images, PDFs and plain text whose sniffed type matches their name; nothing else', () => {
  for (const [path, mime] of [['/c/a.png', 'image/png'], ['/c/a.JPG', 'image/jpeg'], ['/c/r.pdf', 'application/pdf'],
    ['/c/n.txt', 'text/plain'], ['/c/n.md', 'text/markdown'], ['/c/d.csv', 'text/csv'], ['/c/d.json', 'application/json']]) assert.equal(safeToOpen(path, mime), true, path);
  for (const [path, mime] of [['/c/x.desktop', 'application/octet-stream'], ['/c/x.desktop', 'text/plain'], ['/c/run.sh', 'text/plain'],
    ['/c/a.png', 'application/octet-stream'], ['/c/r.pdf', 'text/plain'], ['/c/page.html', 'text/html'], ['/c/i.svg', 'image/svg+xml'],
    ['/c/noext', 'text/plain'], ['/c/a.png', ''], ['', 'image/png'], ['/c/a.png.desktop', 'image/png']]) assert.equal(safeToOpen(path, mime), false, path);
});
