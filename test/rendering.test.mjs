import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { qml } from './composer-harness.test.mjs';

test('activity lists always show actions, select source icons and color rails, and follow status', async t => {
  await qml(t, `
  Plugin.ActivityGroup { id: group; width: 500 }
  Plugin.MessageBubble { id: bubble; width: 500; role: "assistant"; text: "Answer"; phase: "done"; error: ""; activities: "[]" }
  Timer { interval: 150; running: true; onTriggered: {
    try {
      group.activities = [{id:"1", kind:"read", title:"Read a", status:"done"}, {id:"2",kind:"read",title:"Read b",status:"done"}, {id:"3",kind:"shell",title:"Run",status:"done"}]
      if (group.count !== 3) throw Error("actions hidden")
      var icons = {engram:"🧠", slack:"\uf198", linear:"📐", gmail:"\udb80\udeab", notion:"📝", atlassian:"\udb80\udf03", discord:"\udb81\ude6f", rdd:"🛡️", web:"🌐", files:"📄", shell:"⌨️", subagent:"🤝", mcp:"🔌", other:"⚙️"}
      for (var source in icons) if (group.iconFor({source:source,kind:"other"}) !== icons[source]) throw Error(source)
      if (group.iconFor({kind:"memory"}) !== "🧠" || group.iconFor({kind:"edit"}) !== "✏️" || group.iconFor({kind:"ask"}) !== "❓") throw Error("fallback")
      if (group.titleFor({kind:"ask",title:"ignored"}) !== "Asking you") throw Error("ask title")
      if (group.statusFor({status:"running"}) !== "◌" || group.statusFor({status:"failed"}) !== "✗" || group.statusFor({status:"done"}) !== "✓") throw Error("status marks")
      if (String(group.iconColorFor({source:"slack"})) !== "#ee6690") throw Error("brand color")
      group.activities = [{id:"4",kind:"other",source:"engram",title:"Checked notes",status:"running",detail:"query",output:"result"}]
      if (group.count !== 1) throw Error("running hidden")
      group.activities = [{id:"4",kind:"memory",title:"Checked notes",status:"done"}]
      if (group.count !== 1) throw Error("completed hidden")
      var palette = {engram:"#c4a7e7",slack:"#ee6690",linear:"#a6a0ff",gmail:"#ea7369",notion:"#cdd6f4",atlassian:"#74adff",discord:"#8e9aff",rdd:"#f5bde6",web:"#8bd5e8",files:"#a6d6b2",shell:"#edc8a3",subagent:"#f4b8a4",mcp:"#94e2d5",other:"#a5a2b8"}
      for (var source in palette) if (String(group.sourceColorFor({source:source,kind:"other"})) !== palette[source]) throw Error("palette " + source)
      if (group.sourceColorFor({kind:"read"}) === group.sourceColorFor({kind:"edit"})) throw Error("read/edit color")
      if (bubble.fromUser || bubble.assistantTint.a <= 0) throw Error("assistant bubble")
      console.log("QML_PASS"); Qt.quit()
    } catch(e) { console.log("QML_FAIL", String(e)); Qt.exit(1) }
  }}
  `);
});

test('rendering controls use native icon actions and flat hover rows, not stock buttons', async () => {
  for (const name of ['ActivityGroup.qml', 'CodeBlock.qml', 'Collapsible.qml']) {
    const source = await readFile(new URL('../' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bButton\s*\{/);
    if (name !== 'ActivityGroup.qml') assert.match(source, /PanelActionButton\s*\{/);
    else assert.doesNotMatch(source, /property bool expanded|summary|summarize/);
    assert.match(source, /Style\.hoverFillFor/);
  }
});

test('activity list is outside and above the assistant reply, with only per-row details expandable', async t => {
  await qml(t, `
  Plugin.MessageBubble { id: bubble; width: 500; role: "assistant"; text: "Answer"; phase: "done"; error: ""; activities: JSON.stringify([{id:"a",kind:"memory",title:"Checked notes",status:"done",detail:"query",output:"result"}]) }
  function named(item, name) {
    if (item.objectName === name) return item
    for (var i = 0; i < item.children.length; i++) { var found = named(item.children[i], name); if (found) return found }
    return null
  }
  Timer { interval: 150; running: true; onTriggered: {
    try {
      var actions = named(bubble,"messageActivities"), reply = named(bubble,"assistantReply")
      if (!actions || !reply || actions.parent === reply || actions.count !== 1) throw Error("activities not separate")
      if (actions.mapToItem(bubble,0,actions.height).y > reply.mapToItem(bubble,0,0).y) throw Error("activities not above reply")
      var row = named(actions,"activityRow"), hit = named(row,"activityHit")
      if (row.detailsOpen) throw Error("details open by default")
      hit.clicked(null)
      if (!row.detailsOpen || !named(row,"activityDetail").visible || !named(row,"activityOutput").visible) throw Error("details not revealed")
      if (actions.count !== 1) throw Error("list collapsed")
      console.log("QML_PASS"); Qt.quit()
    } catch(e) { console.log("QML_FAIL",String(e)); Qt.exit(1) }
  }}
  `);
});

test('client carries optional rendering fields through history and live deltas, preserving old messages', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false}) }
  Plugin.ChatView { id: chat; width: 600; height: 800; client: client; model: client.messages }
  Timer { interval: 150; running: true; onTriggered: {
    try {
      client.handleLine(JSON.stringify({type:"history",messages:[{id:"old",role:"user",text:"Original"},{id:"new",role:"assistant",text:"code",reasoning:"History thought",segments:[{type:"code",lang:"python",code:"print(1)",html:"print(<span style=\\"color:#f6c177\\">1</span>)"}],activities:[{id:"a",kind:"memory",title:"Checked notes",status:"done"}]}]}))
      if (client.messages.count !== 2 || client.messages.get(0).text !== "Original" || client.messages.get(0).reasoning !== "") throw Error("old message")
      if (client.messages.get(1).reasoning !== "History thought" || JSON.parse(client.messages.get(1).segments)[0].lang !== "python") throw Error("history")
      client.handleLine(JSON.stringify({type:"reasoning_delta",messageId:"live",delta:"Think"}))
      client.handleLine(JSON.stringify({type:"reasoning_delta",messageId:"live",delta:" more"}))
      client.handleLine(JSON.stringify({type:"message_delta",messageId:"live",delta:"Reply"}))
      client.handleLine(JSON.stringify({type:"message_done",messageId:"live",text:"Reply",segments:[{type:"md",text:"Reply"}]}))
      if (client.messages.get(2).reasoning !== "Think more" || client.messages.get(2).phase !== "done") throw Error("stream")
      console.log("QML_PASS"); Qt.quit()
    } catch(e) { console.log("QML_FAIL",String(e)); Qt.exit(1) }
  }}
  `);
});

test('code Copy writes the exact raw code to a clipboard process, not rich HTML', async t => {
  await qml(t, `
  Plugin.CodeBlock { id: code; width: 500; code: "  print(\\\"<hello>\\\")\\n\\t# raw"; html: "<span>not the source</span>"; clipboardCommand: [Qt.resolvedUrl("clipboard").toString().replace("file://", "")] }
  function action(item, name) {
    if (item.objectName === name) return item
    for (var i = 0; i < item.children.length; i++) {
      var found = action(item.children[i], name)
      if (found) return found
    }
    return null
  }
  Timer { interval: 100; running: true; onTriggered: action(code, "codeCopy").clicked() }
  Timer { interval: 500; running: true; onTriggered: {
    if (code.copyState !== "Copied") { console.log("QML_FAIL",code.copyState); Qt.exit(1) }
    else { console.log("QML_PASS"); Qt.quit() }
  }}
  `, {files:{clipboard:`#!/usr/bin/env node
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => process.exit(input === '  print("<hello>")\\n\\t# raw' ? 0 : 1));
`}});
});

test('code, prose and reasoning collapse without changing copy text', async t => {
  await qml(t, `
  Plugin.CodeBlock { id: code; width: 500; code: Array(31).join("const x = 1;\\n"); lang: "typescript" }
  Plugin.Collapsible { id: prose; width: 500; text: Array(42).join("line\\n") }
  Plugin.MessageBubble { id: bubble; width: 500; role: "assistant"; text: "Answer"; phase: "done"; error: ""; activities: "[]"; reasoning: "Thinking privately" }
  function toggle(item) {
    if (item.objectName === "codeToggle") { item.clicked(); return true }
    for (var i = 0; i < item.children.length; i++) if (toggle(item.children[i])) return true
    return false
  }
  Timer { interval: 150; running: true; onTriggered: {
    try {
      if (!code.longContent || code.expanded || code.lineCount !== 31) throw Error("code collapse")
      if (!toggle(code) || !code.expanded) throw Error("native toggle")
      if (code.visibleCode !== code.code) throw Error("copy changed")
      if (!prose.longContent || prose.expanded) throw Error("prose collapse")
      prose.expanded = true
      if (prose.visibleText !== prose.text) throw Error("prose changed")
      console.log("QML_PASS"); Qt.quit()
    } catch(e) { console.log("QML_FAIL", String(e)); Qt.exit(1) }
  }}
  `);
});
