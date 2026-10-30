import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { poll, qml } from './composer-harness.test.mjs';

const named = `
  function named(item, name) {
    if (item.objectName === name) return item
    for (var i = 0; i < item.children.length; i++) { var found = named(item.children[i], name); if (found) return found }
    return null
  }
  function shown(item, name) {
    if (!item.visible) return null
    if (item.objectName === name) return item
    for (var i = 0; i < item.children.length; i++) { var found = shown(item.children[i], name); if (found) return found }
    return null
  }`;

// Runs the statements in a TestCase once the scene exists: QML_PASS unless one throws.
const checks = body => `
  TestCase {
    id: checks; name: "Bubble"; when: false
    ${named}
    ${poll}
    function run() {
      try {
        ${body}
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 0; running: true; onTriggered: checks.run() }`;

test('assistant bubble keeps the rose tint and gains a rose left rail like the action lines', async t => {
  await qml(t, `
  Plugin.MessageBubble { id: bubble; width: 500; role: "assistant"; text: "Answer"; phase: "done"; error: ""; activities: JSON.stringify([{id:"a",kind:"memory",title:"Notes",status:"done"}]) }
  ${checks(`
    settle(function() {
      var reply = named(bubble, "assistantReply"), rail = named(bubble, "assistantRail"), actions = named(bubble, "messageActivities")
      if (!reply || !rail || rail.parent !== reply) throw Error("no rail in the reply")
      if (bubble.assistantTint.a <= 0 || bubble.assistantTint.a >= 0.5) throw Error("tint")
      if (Math.abs(rail.color.r - bubble.assistantTint.r) > 0.01 || rail.color.a !== 1) throw Error("rail color " + rail.color)
      var actionRail = named(actions, "activityRow").children[0]
      if (rail.width !== actionRail.width || rail.x !== 0 || rail.height !== reply.height) throw Error("rail geometry " + rail.width + " " + actionRail.width)
    })
  `)}
  `);
});

test('reply copy icon sends the raw text to the clipboard and shows Copied for about 1.5 s', async t => {
  await qml(t, `
  Plugin.MessageBubble { id: bubble; width: 500; role: "assistant"; phase: "done"; error: ""; activities: "[]"
    text: "**Bold** <b>x</b>\\n\\n\\\`\\\`\\\`js\\nlet a = 1\\n\\\`\\\`\\\`"
    segments: JSON.stringify([{type:"md",text:"rendered"}])
    clipboardCommand: [Qt.resolvedUrl("clipboard").toString().replace("file://", "")] }
  Plugin.MessageBubble { id: streaming; width: 500; role: "assistant"; phase: "streaming"; error: ""; activities: "[]"; text: "partial" }
  Plugin.MessageBubble { id: user; width: 500; role: "user"; phase: "done"; error: ""; activities: "[]"; text: "mine" }
  // When Copied starts and ends, taken as it happens (polling would see it late under load).
  property real copiedAt: 0
  property real resetAt: 0
  Connections {
    target: bubble
    function onCopyStateChanged() { if (bubble.copyState === "copied") copiedAt = Date.now(); else if (bubble.copyState === "idle") resetAt = Date.now() }
  }
  ${checks(`
    var copy = null
    settle(function() {
      copy = named(bubble, "replyCopy")
      if (!copy || !copy.visible || copy.iconText !== "󰆏" || copy.tooltipText !== "Copy reply") throw Error("copy icon")
      if (named(streaming, "replyCopy").visible) throw Error("copy while streaming")
      if (shown(user, "replyCopy")) throw Error("copy on user message")
    })
    copy.clicked()
    until(function() { return bubble.copyState !== "idle" }, 10000, "the clipboard command finishes")
    if (bubble.copyState !== "copied" || copy.iconText !== "󰄬" || copy.tooltipText !== "Copied") throw Error("copied " + bubble.copyState)
    until(function() { return bubble.copyState === "idle" }, 10000, "Copied resets")
    // A lower bound only (load can only make it later).
    if (resetAt - copiedAt < 1000) throw Error("Copied for about 1.5 s, not " + (resetAt - copiedAt))
    if (copy.iconText !== "󰆏") throw Error("reset icon")
  `)}
  `, {files:{clipboard:`#!/usr/bin/env node
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => process.exit(input === '**Bold** <b>x</b>\\n\\n\`\`\`js\\nlet a = 1\\n\`\`\`' ? 0 : 1));
`}, timeout: 30000});
});

test('every message shows a small muted timestamp when it has a time, and none without', async t => {
  await qml(t, `
  property real fixedNow: new Date(2026, 9, 27, 15, 30, 0).getTime()
  Plugin.MessageBubble { id: reply; width: 500; role: "assistant"; text: "Answer"; phase: "done"; error: ""; activities: "[]"; at: fixedNow - 5 * 60000; now: fixedNow }
  Plugin.MessageBubble { id: user; width: 500; role: "user"; text: "Question"; phase: "done"; error: ""; activities: "[]"; at: fixedNow - 30000; now: fixedNow }
  Plugin.MessageBubble { id: old; width: 500; role: "user"; text: "Older"; phase: "done"; error: ""; activities: "[]"; at: new Date(2026, 9, 26, 9, 0).getTime(); now: fixedNow }
  Plugin.MessageBubble { id: none; width: 500; role: "assistant"; text: "History"; phase: "done"; error: ""; activities: "[]" }
  ${checks(`
    var a = null
    settle(function() {
      a = shown(reply, "messageTime")
      var u = shown(user, "messageTime"), o = shown(old, "messageTime")
      if (!a || a.text !== "5 min ago") throw Error("assistant time")
      if (!u || u.text !== "just now") throw Error("user time")
      if (!o || o.text !== "Oct 26") throw Error("date")
      if (shown(none, "messageTime")) throw Error("invented a time")
      if (u.font.pixelSize >= named(user, "userText").font.pixelSize || a.color.a >= 0.9) throw Error("not small and muted")
    })
    reply.now = fixedNow + 60 * 60000
    if (a.text !== "1 h ago") throw Error("no refresh " + a.text)
  `)}
  `);
});

test('a reply that starts streaming without a time still gets its footer when it is stamped and done', async t => {
  await qml(t, `
  FloatingWindow {
    visible: true; width: 600; height: 400
    Plugin.MessageBubble { id: live; width: 500; role: "assistant"; text: ""; phase: "streaming"; error: ""; activities: "[]" }
  }
  ${checks(`
    // Laid out (and drawn) while still empty and hidden, then the text arrives.
    waitForRendering(live, 5000)
    live.text = "Hello"; live.at = Date.now(); live.phase = "done"
    settle(function() {
      if (!shown(live, "messageTime") || !shown(live, "replyCopy")) throw Error("footer stuck hidden")
    })
  `)}
  `);
});

test('client stamps live messages on arrival, keeps daemon times and never invents history times', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false}) }
  ${checks(`
    var before = Date.now()
    client.handleDaemon(({type:"history",messages:[{id:"h1",role:"user",text:"old"},{id:"h2",role:"assistant",text:"timed",at:"2026-10-20T10:00:00.000Z"}]}))
    if (client.messages.get(0).at !== 0) throw Error("history time invented")
    if (client.messages.get(1).at !== Date.parse("2026-10-20T10:00:00.000Z")) throw Error("history at")
    client.handleDaemon(({type:"user_message",messageId:"u",text:"hi"}))
    var u = client.messages.get(2).at
    if (u < before || u > Date.now()) throw Error("user receipt time")
    client.handleDaemon(({type:"activity",messageId:"r",activity:{id:"x",kind:"read",title:"Read",status:"running"}}))
    if (client.messages.get(3).at !== 0) throw Error("activity stamped")
    client.handleDaemon(({type:"message_delta",messageId:"r",delta:"Hel"}))
    var first = client.messages.get(3).at
    if (first < before) throw Error("first delta not stamped")
    var later = Date.now() + 20
    until(function() { return Date.now() >= later })
    client.handleDaemon(({type:"message_delta",messageId:"r",delta:"lo"}))
    client.handleDaemon(({type:"message_done",messageId:"r",text:"Hello"}))
    if (client.messages.get(3).at !== first) throw Error("restamped")
    client.handleDaemon(({type:"message_done",messageId:"d",text:"Done",at:1793137664830}))
    if (client.messages.get(4).at !== 1793137664830) throw Error("done at")
    client.handleDaemon(({type:"user_message",messageId:"u2",text:"x",at:1793137000000}))
    if (client.messages.get(5).at !== 1793137000000) throw Error("user at")
    if (!(client.now > 0) || client.clockInterval !== 60000) throw Error("shared clock")
  `)}
  `);
});

test('panel opacity defaults to 0.95, is clamped, and is saved with every other setting', async t => {
  await qml(t, `
  Plugin.Client {
    id: client
    shell: QtObject { property var saved: null; function updateEntryInline(id, next) { saved = next; return true } }
  }
  Plugin.DetachedWindow { id: detached; background: Qt.rgba(0.1, 0.2, 0.3, client.panelOpacity) }
  ${checks(`
    if (client.panelOpacity !== 0.95) throw Error("default " + client.panelOpacity)
    client.entrySettings = ({panelOpacity: 0.2})
    if (client.panelOpacity !== 0.5) throw Error("low clamp " + client.panelOpacity)
    client.entrySettings = ({panelOpacity: 3})
    if (client.panelOpacity !== 1) throw Error("high clamp")
    client.entrySettings = ({panelOpacity: "nope"})
    if (client.panelOpacity !== 0.95) throw Error("bad value")
    client.entrySettings = ({serverUrl: "wss://mac/ws", tokenFile: "~/t", notifications: false})
    if (!client.savePanelOpacity(0.85)) throw Error("save failed")
    var saved = client.shell.saved
    if (saved.panelOpacity !== 0.85 || saved.serverUrl !== "wss://mac/ws" || saved.tokenFile !== "~/t" || saved.notifications !== false) throw Error("saved " + JSON.stringify(saved))
    if (client.panelOpacity !== 0.85) throw Error("not applied")
    if (Math.abs(detached.color.a - 0.85) > 0.01) throw Error("detached background " + detached.color.a)
  `)}
  `);
});

test('popup, pinned and detached surfaces all draw the translucent panel background', async () => {
  const panel = await readFile(new URL('../Panel.qml', import.meta.url), 'utf8');
  assert.match(panel, /panelOpacity: setting\("panelOpacity", 0\.95\)/);
  assert.match(panel, /StickyPanel \{[\s\S]*?background: root\.panelBackground/);
  assert.match(panel, /DetachedWindow \{[\s\S]*?background: root\.panelBackground/);
  assert.match(panel, /Binding \{[\s\S]*?property: "color"[\s\S]*?value: root\.panelBackground/);
  const sticky = await readFile(new URL('../StickyPanel.qml', import.meta.url), 'utf8');
  assert.match(sticky, /color: root\.background/);
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.barWidget.defaults.panelOpacity, 0.95);
  assert.ok(manifest.barWidget.schema.some(s => s.key === 'panelOpacity' && s.defaultValue === 0.95));
});

// The footer (time + copy) shares the last text line when it fits, instead of adding a row.
test('reply footer sits on the last text line when there is room, and gets its own row otherwise', async t => {
  await qml(t, `
  Plugin.MessageBubble { id: short; width: 500; role: "assistant"; text: "Not logged in"; phase: "done"; error: ""; activities: "[]"
    segments: JSON.stringify([{type:"md",text:"Not logged in"}]) }
  Plugin.MessageBubble { id: full; width: 500; role: "assistant"; phase: "done"; error: ""; activities: "[]"
    text: fullLine; segments: JSON.stringify([{type:"md",text:fullLine}]) }
  property string fullLine: ""
  FontMetrics { id: metrics }
  ${checks(`
    // One line of "M" exactly as wide as the reply column: no room left for the footer.
    settle(function() {
      var prose = named(short, "proseText")
      if (!prose || !(prose.width > 0)) throw Error("not laid out")
      metrics.font = prose.textItem.font
      fullLine = "M".repeat(Math.floor(prose.width / metrics.advanceWidth("M")))
    })
    settle(function() {
      var copy = named(short, "replyCopy"), prose = named(short, "proseText"), reply = named(short, "assistantReply")
      if (!short.footerInline) throw Error("short reply: footer not inline")
      var c = copy.mapToItem(reply, 0, 0), p = prose.mapToItem(reply, 0, 0)
      if (c.y + copy.height / 2 < p.y || c.y + copy.height / 2 > p.y + prose.height + 2) throw Error("copy not on the text line: " + c.y + " vs " + p.y + "+" + prose.height)
      // Same padding above and below the text: no extra footer row.
      if (Math.abs(reply.height - (prose.height + 2 * p.y)) > 1) throw Error("short reply still adds a footer row: " + reply.height + " vs " + prose.height + "+" + 2 * p.y)
      if (full.footerInline) throw Error("full last line: footer must get its own row")
      var fcopy = named(full, "replyCopy"), fprose = named(full, "proseText"), freply = named(full, "assistantReply")
      if (fcopy.mapToItem(freply, 0, 0).y < fprose.mapToItem(freply, 0, 0).y + fprose.height - 1) throw Error("full: copy overlaps the text: copy " + fcopy.mapToItem(freply, 0, 0).y + " prose " + fprose.mapToItem(freply, 0, 0).y + "+" + fprose.height + " reply " + freply.height + " lastLine " + full.lastLineRect + " len " + fullLine.length)
      // The text arrived after the bubble was created (streaming): the card still grows to hold it.
      if (freply.height < fcopy.mapToItem(freply, 0, 0).y + fcopy.height) throw Error("full: card does not contain its footer: " + freply.height)
    })
  `)}
  `);
});

// S14.11: times sit in the side gutters, outside the cards: left of the user's card, right of
// the reply card, bottom-aligned with the card's last line. The gutter is always reserved, so a
// message without a time has the same card width (no jump when it gets stamped).
test('message times sit in the side gutters, outside the cards and bottom-aligned with their last line', async t => {
  await qml(t, `
  property real fixedNow: new Date(2026, 9, 27, 15, 30, 0).getTime()
  property real lastYear: new Date(2025, 9, 26, 9, 0).getTime()
  property string longText: Array(60).join("word ")
  property string files: JSON.stringify([{name:"report.pdf", size:2048, mime:"application/pdf"}])
  Plugin.MessageBubble { id: user; width: 500; role: "user"; text: "Question"; phase: "done"; error: ""; activities: "[]"; at: fixedNow - 12 * 60000; now: fixedNow }
  Plugin.MessageBubble { id: longUser; width: 500; role: "user"; text: longText; phase: "done"; error: ""; activities: "[]"; at: lastYear; now: fixedNow }
  Plugin.MessageBubble { id: untimedUser; width: 500; role: "user"; text: longText; phase: "done"; error: ""; activities: "[]" }
  Plugin.MessageBubble { id: withFiles; width: 500; role: "user"; text: "See this"; phase: "done"; error: ""; activities: "[]"; attachments: files; at: fixedNow - 60000; now: fixedNow }
  Plugin.MessageBubble { id: filesOnly; width: 500; role: "user"; text: ""; phase: "done"; error: ""; activities: "[]"; attachments: files; at: fixedNow - 60000; now: fixedNow }
  Plugin.MessageBubble { id: reply; width: 500; role: "assistant"; text: "Not logged in"; phase: "done"; error: ""; at: lastYear; now: fixedNow
    segments: JSON.stringify([{type:"md",text:"Not logged in"}]); activities: JSON.stringify([{id:"a",kind:"memory",title:"Notes",status:"done"}]) }
  Plugin.MessageBubble { id: untimedReply; width: 500; role: "assistant"; text: "Not logged in"; phase: "done"; error: ""; activities: "[]"
    segments: JSON.stringify([{type:"md",text:"Not logged in"}]) }
  function box(item, ref) { var p = item.mapToItem(ref, 0, 0); return {x: p.x, y: p.y, r: p.x + item.width, b: p.y + item.height} }
  function apart(a, b) { return a.r <= b.x || b.r <= a.x || a.b <= b.y || b.b <= a.y }
  ${checks(`
    settle(function() {
      // User: left of the card, outside it, bottom-aligned with the last text line.
      var time = shown(user, "messageTime"), card = named(user, "userCard")
      if (!time || !card || time.text !== "12 min ago") throw Error("user time " + (time && time.text))
      if (shown(card, "messageTime")) throw Error("user time inside the card")
      var t = box(time, user), c = box(card, user), txt = box(named(user, "userText"), user)
      if (t.r > c.x - 2) throw Error("user time not left of the card: " + t.r + " vs " + c.x)
      if (Math.abs(t.b - txt.b) > 2) throw Error("user time not bottom-aligned: " + t.b + " vs " + txt.b)
      if (user.implicitHeight > c.b + 0.5) throw Error("user time adds a row: " + user.implicitHeight + " vs " + c.b)
      // The widest label ("Oct 26, 2025") still fits left of a full-width card.
      time = shown(longUser, "messageTime"); card = named(longUser, "userCard")
      t = box(time, longUser); c = box(card, longUser); txt = box(named(longUser, "userText"), longUser)
      if (time.text !== "Oct 26, 2025") throw Error("date " + time.text)
      if (c.b - c.y < 3 * time.height) throw Error("long user text is not multi-line")
      if (t.x < 0 || t.r > c.x - 2) throw Error("widest time does not fit the gutter: " + t.x + ".." + t.r + " card " + c.x)
      if (Math.abs(t.b - txt.b) > 2) throw Error("long user time not on the last line: " + t.b + " vs " + txt.b)
      if (named(untimedUser, "userCard").width !== card.width) throw Error("user gutter jumps without a time")
      if (shown(untimedUser, "messageTime")) throw Error("invented a time")
      // Attachments: the time never overlaps them; with no text it sits left of them.
      time = shown(withFiles, "messageTime")
      if (!apart(box(time, withFiles), box(named(withFiles, "userAttachments"), withFiles))) throw Error("time overlaps the attachments")
      if (Math.abs(box(time, withFiles).b - box(named(withFiles, "userText"), withFiles).b) > 2) throw Error("files: time not on the card's last line")
      time = shown(filesOnly, "messageTime")
      var f = box(named(filesOnly, "userAttachments"), filesOnly)
      t = box(time, filesOnly)
      if (!time || t.r > f.x - 2 || Math.abs(t.b - f.b) > 2) throw Error("attachment-only time: " + JSON.stringify(t) + " vs " + JSON.stringify(f))

      // Assistant: right of the card, outside it, bottom-aligned with the last line.
      time = shown(reply, "messageTime"); card = named(reply, "assistantReply")
      if (!time || time.text !== "Oct 26, 2025") throw Error("reply time " + (time && time.text))
      if (shown(card, "messageTime")) throw Error("reply time inside the card")
      t = box(time, reply); c = box(card, reply)
      var prose = box(named(reply, "proseText"), reply), acts = box(named(reply, "messageActivities"), reply)
      if (t.x < c.r + 2 || t.r > reply.width) throw Error("reply time not in the right gutter: " + t.x + ".." + t.r + " card " + c.r)
      if (Math.abs(t.b - prose.b) > 2) throw Error("reply time not bottom-aligned: " + t.b + " vs " + prose.b)
      if (!apart(t, acts)) throw Error("reply time overlaps the action lines")
      // Copy stays inside the card, inline on the last line.
      if (!reply.footerInline) throw Error("copy not inline")
      var copy = box(named(reply, "replyCopy"), reply)
      if (copy.x < c.x || copy.r > c.r || copy.y < c.y || copy.b > c.b) throw Error("copy outside the card")
      if (named(untimedReply, "assistantReply").width !== card.width) throw Error("reply gutter jumps without a time")
      if (shown(untimedReply, "messageTime") || !shown(untimedReply, "replyCopy")) throw Error("untimed reply footer")
    })
  `)}
  `);
});

// S14.13: the copy icon and the time are hover-only chrome. They keep their place in the layout
// (opacity, never visibility) and fade in when the pointer is over that message (its card, the
// gutter time or its action lines), and out after a short grace once it leaves.
const hoverScene = `
  property real fixedNow: new Date(2026, 9, 27, 15, 30, 0).getTime()
  FloatingWindow {
    id: win; visible: true; width: 640; height: 900
    Column {
      x: 20; y: 20; width: 560; spacing: 12
      Plugin.MessageBubble { id: user; width: parent.width; role: "user"; text: "Question"; phase: "done"; error: ""; activities: "[]"; at: fixedNow - 60000; now: fixedNow }
      Plugin.MessageBubble { id: reply; width: parent.width; role: "assistant"; text: "Not logged in, try again"; phase: "done"; error: ""; at: fixedNow - 120000; now: fixedNow
        segments: JSON.stringify([{type:"md",text:"Not logged in, try again"}]); activities: JSON.stringify([{id:"a",kind:"memory",title:"Notes",status:"done"}])
        clipboardCommand: [Qt.resolvedUrl("clipboard").toString().replace("file://", "")] }
      Plugin.MessageBubble { id: other; width: parent.width; role: "assistant"; text: "Second answer"; phase: "done"; error: ""; activities: "[]"; at: fixedNow - 30000; now: fixedNow
        segments: JSON.stringify([{type:"md",text:"Second answer"}]) }
    }
  }`;
// Inside the TestCase, so they can use its mouse and polling helpers.
const hoverHelpers = `
  ${named}
  ${poll}
  function chrome(bubble) { return {time: shown(bubble, "messageTime"), copy: shown(bubble, "replyCopy")} }
  function hidden(bubble) {
    var c = chrome(bubble)
    return c.time.opacity === 0 && (!c.copy || (c.copy.opacity === 0 && !c.copy.enabled))
  }
  function full(bubble) {
    var c = chrome(bubble)
    return c.time.opacity === 1 && (!c.copy || (c.copy.opacity === 1 && c.copy.enabled))
  }
  function away() { mouseMove(win.contentItem, win.width - 4, win.height - 4) }
  function geometry() {
    var items = [user, reply, other, named(user, "userCard"), named(reply, "assistantReply"), named(other, "assistantReply"),
      named(reply, "proseText"), named(reply, "messageActivities"), chrome(user).time, chrome(reply).time, chrome(reply).copy, chrome(other).time, chrome(other).copy]
    return JSON.stringify(items.map(function(item) { var p = item.mapToItem(win.contentItem, 0, 0); return [p.x, p.y, item.width, item.height] }))
  }
  function ready() {
    until(function() {
      return named(reply, "assistantReply").height > 0 && chrome(user).time && chrome(reply).time && chrome(reply).copy && chrome(other).copy
    }, 10000, "bubbles laid out")
  }`;
const sh = { files: { clipboard: '#!/bin/sh\ncat > /dev/null\n' }, timeout: 30000 };

test('copy and time are hidden until that message is hovered, then fade in and out after a grace without moving the layout', async t => {
  await qml(t, `
  ${hoverScene}
  TestCase {
    id: checks; name: "HoverChrome"; when: false
    ${hoverHelpers}
    function run() {
      try {
        ready()
        away()
        check(hidden(user) && hidden(reply) && hidden(other), "hidden by default (opacity 0, copy not interactive)")
        var layout = geometry()

        var card = named(reply, "assistantReply")
        mouseMove(card, card.width / 2, card.height / 2)
        check(chrome(reply).copy.opacity < 1, "fades in rather than popping")
        until(function() { return full(reply) }, 5000, "hovering the card shows copy and time")
        check(hidden(user) && hidden(other), "only the hovered message shows its chrome")
        check(geometry() === layout, "the layout does not move" + ": " + geometry() + " vs " + layout)

        // The gutter time and the action lines belong to the same message.
        var time = chrome(reply).time
        mouseMove(time, time.width / 2, time.height / 2)
        check(full(reply), "the gutter time keeps it shown")
        var acts = named(reply, "messageActivities")
        mouseMove(acts, acts.width / 2, acts.height / 2)
        check(full(reply), "the action lines keep it shown")
        var copy = chrome(reply).copy
        mouseMove(copy, copy.width / 2, copy.height / 2)
        check(full(reply), "the copy icon keeps it shown")

        // Leaving: still shown during the grace, then fades out.
        away()
        var left = Date.now()
        check(full(reply), "still shown right after leaving (grace)")
        until(function() { return hidden(reply) }, 5000, "hidden after leaving")
        // A lower bound only (load can only make it later): more than the fade alone.
        check(Date.now() - left >= 300, "grace (~250 ms) before the fade (~200 ms): " + (Date.now() - left))
        check(geometry() === layout, "the layout does not move" + ": " + geometry() + " vs " + layout)

        // The user's message: its card and its left-gutter time; the empty row beyond is not it.
        var userCard = named(user, "userCard")
        mouseMove(userCard, userCard.width / 2, userCard.height / 2)
        until(function() { return full(user) }, 5000, "hovering the user's card shows its time")
        check(hidden(reply) && hidden(other))
        var userTime = chrome(user).time
        mouseMove(userTime, 1, userTime.height / 2)
        check(full(user), "the gutter time keeps it shown")
        mouseMove(user, 2, user.height / 2)
        until(function() { return hidden(user) }, 5000, "the empty part of the row is not the message")

        // Hovering message B never shows message A's chrome.
        var otherCard = named(other, "assistantReply")
        mouseMove(otherCard, otherCard.width / 2, otherCard.height / 2)
        until(function() { return full(other) }, 5000)
        check(hidden(user) && hidden(reply), "A stays hidden while B is hovered")
        away()
        until(function() { return hidden(other) }, 5000)
        check(geometry() === layout, "the layout does not move" + ": " + geometry() + " vs " + layout)
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  `, sh);
});

test('hover chrome never steals clicks or selection: copy still copies, Copied keeps it shown, keyboard focus and touch show it', async t => {
  await qml(t, `
  ${hoverScene}
  TestCase {
    id: checks; name: "HoverChromeInput"; when: false
    ${hoverHelpers}
    function run() {
      try {
        ready()
        away()
        var card = named(reply, "assistantReply"), copy = chrome(reply).copy
        // A hidden copy icon is not clickable.
        mouseClick(copy)
        wait(50)
        check(reply.copyState === "idle", "a hidden copy icon does not copy")

        // Selecting reply text with the mouse still works over the hover target.
        var text = named(reply, "proseText").textItem
        mouseDrag(text, 1, text.height / 2, text.width / 2, 0)
        check(text.selectedText.length > 0, "text selection still works")
        until(function() { return full(reply) }, 5000)
        // Focus from a mouse click does not pin the chrome once the pointer leaves.
        away()
        until(function() { return hidden(reply) }, 5000, "mouse focus does not keep it shown")

        // Copy through real hit-testing while hovered; Copied keeps it shown after the pointer leaves.
        mouseMove(card, card.width / 2, card.height / 2)
        until(function() { return full(reply) }, 5000)
        mouseClick(copy)
        until(function() { return reply.copyState === "copied" }, 10000, "reply.copyState " + reply.copyState)
        check(copy.iconText === "󰄬" && copy.tooltipText === "Copied")
        away()
        wait(500)
        check(reply.copyState !== "copied" || full(reply), "shown while it reports Copied")
        until(function() { return reply.copyState === "idle" }, 10000, "reply.copyState " + reply.copyState)
        until(function() { return hidden(reply) }, 5000, "hidden once Copied resets")

        // Keyboard focus on a Tab-reachable control inside the message shows it; leaving hides it.
        text.activeFocusOnTab = true
        text.forceActiveFocus(Qt.TabFocusReason)
        until(function() { return full(reply) }, 5000, "keyboard focus inside shows it")
        check(hidden(other) && hidden(user))
        win.contentItem.forceActiveFocus()
        until(function() { return hidden(reply) }, 5000, "focus left")

        // Touch: a tap on the card toggles it.
        var otherCard = named(other, "assistantReply")
        var touch = touchEvent(otherCard)
        touch.press(0, otherCard, otherCard.width / 2, otherCard.height / 2).commit()
        touch.release(0, otherCard, otherCard.width / 2, otherCard.height / 2).commit()
        until(function() { return full(other) }, 5000, "a tap shows it")
        wait(500)
        check(full(other), "stays after the tap")
        touch.press(0, otherCard, otherCard.width / 2, otherCard.height / 2).commit()
        touch.release(0, otherCard, otherCard.width / 2, otherCard.height / 2).commit()
        until(function() { return hidden(other) }, 5000, "a second tap hides it")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  `, sh);
});
