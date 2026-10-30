import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { poll, qml } from './composer-harness.test.mjs';
import { withView } from '../bridge/activity-view.mjs';

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

test('expanded actions render the bridge view: highlighted command, terminal output, result list, path with copy; no view keeps raw text', async t => {
  const activities = [
    withView({ id: 's', kind: 'run', title: 'Ran a command', status: 'done', tool: 'bash', source: 'shell', detail: '{"command":"ls -d ~/x","timeout":30}', output: 'x\ny\n' }),
    withView({ id: 'm', kind: 'memory', title: 'Checked my notes', status: 'done', tool: 'mem_search', source: 'engram', detail: '{"query":"gentle"}', output: '[{"title":"One","type":"bugfix","project":"p"},{"title":"Tw' }),
    withView({ id: 'r', kind: 'read', title: 'Read a.ts', status: 'done', tool: 'read', source: 'files', detail: '{"path":"/src/a.ts"}', output: 'const a = 1;' }),
    { id: 'o', kind: 'run', title: 'Ran a command', status: 'done', detail: '{"command":"old"}', output: 'raw output' },
  ];
  await qml(t, `
  Plugin.ActivityGroup { id: group; width: 500; activities: ${JSON.stringify(activities)} }
  function named(item, name) {
    if (item.objectName === name) return item
    for (var i = 0; i < item.children.length; i++) { var found = named(item.children[i], name); if (found) return found }
    return null
  }
  function all(item, name, out) {
    out = out || []
    if (item.objectName === name) out.push(item)
    for (var i = 0; i < item.children.length; i++) all(item.children[i], name, out)
    return out
  }
  TestCase {
    id: checks; when: false
    ${poll}
    function run() {
      try {
        var rows = all(group, "activityRow")
        check(rows.length === 4, "rows " + rows.length)
        for (var i = 0; i < rows.length; i++) named(rows[i], "activityHit").clicked(null)
        var shell = rows[0], memory = rows[1], read = rows[2], old = rows[3]
        until(function() { return named(shell, "activityDetailView") && named(shell, "activityOutputView") }, 5000, "views load")
        var code = named(named(shell, "activityDetailView"), "detailCode")
        check(code && code.visible && code.code === "ls -d ~/x" && code.lang === "bash", "command code")
        check(/<span style="color:#/.test(code.html), "command highlighted")
        check(named(code, "codeCopy") !== null, "command copy")
        var field = named(named(shell, "activityDetailView"), "detailField")
        check(field && field.visible && field.text === "timeout: 30", "extra field " + (field && field.text))
        var terminal = named(named(shell, "activityOutputView"), "detailTerminal")
        check(terminal && terminal.visible && terminal.code === "x\\ny", "terminal " + (terminal && terminal.code))
        check(named(terminal, "codeCopy") !== null, "terminal copy")
        check(!named(shell, "activityDetail").visible && !named(shell, "activityOutput").visible, "raw text hidden with a view")
        var items = all(named(memory, "activityOutputView"), "detailListItem")
        check(items.length === 1 && items[0].text === "One" && items[0].meta === "bugfix · p", "list items")
        var more = named(named(memory, "activityOutputView"), "detailMore")
        check(more && more.visible && more.text === "+1 more…", "more " + (more && more.text))
        var path = named(named(read, "activityDetailView"), "detailPath")
        check(path && path.visible && path.text === "/src/a.ts", "path")
        check(named(named(read, "activityDetailView"), "detailPathCopy") !== null, "path copy")
        var readCode = named(named(read, "activityOutputView"), "detailCode")
        check(readCode && readCode.visible && readCode.lang === "typescript", "read code")
        check(named(old, "activityDetailView") === null, "no view for an old activity")
        check(named(old, "activityDetail").visible && named(old, "activityDetail").text === '{"command":"old"}', "raw detail")
        check(named(old, "activityOutput").visible && named(old, "activityOutput").text === "raw output", "raw output")
        named(shell, "activityHit").clicked(null)
        until(function() { return named(shell, "activityDetailView") === null }, 5000, "views unload when closed")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL", String(e)) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  `);
});

test('client carries optional rendering fields through history and live deltas, preserving old messages', async t => {
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications:false}) }
  Plugin.ChatView { id: chat; width: 600; height: 800; client: client; model: client.messages }
  Timer { interval: 150; running: true; onTriggered: {
    try {
      client.handleDaemon(({type:"history",messages:[{id:"old",role:"user",text:"Original"},{id:"new",role:"assistant",text:"code",reasoning:"History thought",segments:[{type:"code",lang:"python",code:"print(1)",html:"print(<span style=\\"color:#f6c177\\">1</span>)"}],activities:[{id:"a",kind:"memory",title:"Checked notes",status:"done"}]}]}))
      if (client.messages.count !== 2 || client.messages.get(0).text !== "Original" || client.messages.get(0).reasoning !== "") throw Error("old message")
      if (client.messages.get(1).reasoning !== "History thought" || JSON.parse(client.messages.get(1).segments)[0].lang !== "python") throw Error("history")
      client.handleDaemon(({type:"reasoning_delta",messageId:"live",delta:"Think"}))
      client.handleDaemon(({type:"reasoning_delta",messageId:"live",delta:" more"}))
      client.handleDaemon(({type:"message_delta",messageId:"live",delta:"Reply"}))
      client.handleDaemon(({type:"message_done",messageId:"live",text:"Reply",segments:[{type:"md",text:"Reply"}]}))
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
  TestCase {
    id: checks; when: false
    ${poll}
    function run() {
      try {
        action(code, "codeCopy").clicked()
        // The clipboard command is a Node process: done when it exits, however long that takes.
        until(function() { return code.copyState !== "Copy" }, 10000, "the clipboard command finishes")
        check(code.copyState === "Copied", code.copyState)
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL", String(e)) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
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
