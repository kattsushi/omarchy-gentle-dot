import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { qml } from './composer-harness.test.mjs';

// Panel.qml needs the real bar and layer shell, so its header is checked from the source: every
// place it shows connection details goes through the service's masking, and it reports when its
// popup, pinned panel or detached window opens and closes. The live shell shows the rendering.
test('privacy: the panel header and chat placeholders show connection details only through the mask', async () => {
  const panel = await readFile(new URL('../Panel.qml', import.meta.url), 'utf8');
  assert.match(panel, /title: root\.client \? root\.client\.headerTitle : "Gentle Dot"/);
  assert.match(panel, /\(" \+ root\.client\.displayUrl\(root\.webUrl\(\)\) \+ "\)"/);
  assert.match(panel, /root\.client\.displayUrl\(root\.client\.serverUrl\)/);
  assert.match(panel, /root\.client\.displayText\(root\.client\.fatalMessage\)/);
  assert.match(panel, /root\.client\.displayText\(root\.client\.notice\)/);
  assert.match(panel, /client\.reportPanelOpen\(root, contentOpen\)/);
  assert.match(panel, /client\.reportPanelOpen\(root, false\)/);
  // The eye sits with the other header actions (settings, pin, detach, close), not by the title.
  assert.doesNotMatch(panel, /trailingControl/);
  const actions = panel.slice(panel.indexOf("// Icon-only actions"));
  assert.match(actions, /^[\s\S]*?Row \{[\s\S]*?PanelActionButton \{[\s\S]*?iconText: root\.client \? root\.client\.privacyIcon[\s\S]*?setPrivacyMasked\(!root\.client\.privacyMasked\)[\s\S]*?root\.settingsOpen \? "󰁍" : "󰒓"/);
  // No raw host, URL, token path, notice or fatal message in any displayed string.
  for (const line of panel.split('\n').filter(line => /^\s*(text|title|meta|detail):/.test(line))) {
    assert.doesNotMatch(line, /client\.(host|serverUrl|tokenFile|notice|fatalMessage|testMessage)\b(?!\))/, line);
    assert.doesNotMatch(line, /[^(]root\.webUrl\(\)/, line);
  }
});

// A remote connection on a tailnet device, set without starting a bridge, and two tailnet peers.
const remoteClient = `
  Plugin.Client {
    id: client
    entrySettings: ({notifications: false})
    property int saves: 0
    shell: QtObject { function updateEntryInline(id, settings) { client.saves++; return true } }
    Component.onCompleted: {
      configured = true; nodePath = "node"
      serverUrl = "wss://studio-mac.tailnet-example.ts.net/ws"
      tokenFile = "~/.config/gentle-dot/remotes/studio-mac.tailnet-example.ts.net.token"
      tailnet.available = true
      tailnet.peers = [
        {hostName: "studio-mac", dnsName: "studio-mac.tailnet-example.ts.net", ip: "100.64.0.42", os: "macOS", online: true},
        {hostName: "pixel-seven", dnsName: "pixel-seven.tailnet-example.ts.net", ip: "fd7a:115c:a1e0::7", os: "android", online: false}
      ]
    }
  }`;

// Every string the user can see under an item (labels, fields, list rows), from the item tree.
const helpers = `
    function shown(item, out) {
      out = out || []
      if (!item || item.visible === false) return out
      if (typeof item.text === "string" && item.text !== "") out.push(item.text)
      var kids = item.children || []
      for (var i = 0; i < kids.length; i++) shown(kids[i], out)
      if (item.contentItem && kids.indexOf(item.contentItem) < 0) shown(item.contentItem, out)
      return out
    }
    function screen(item) { return shown(item).join("\\n") }
    function hidesAll(item, label) {
      var text = screen(item)
      var secrets = ["studio", "tailnet-example", "ts.net", "100.64", "64.0.42", "pixel-seven", "fd7a", "a1e0", ".token"]
      for (var i = 0; i < secrets.length; i++)
        if (text.indexOf(secrets[i]) >= 0) throw Error(label + ": leaks " + secrets[i] + " in\\n" + text)
      return text
    }
    function rows(view) {
      var found = []
      var kids = view.contentItem.children
      for (var i = 0; i < kids.length; i++) if (kids[i].modelData) found.push(kids[i])
      return found.sort(function(a, b) { return a.y - b.y })
    }`;

test('privacy: settings masked by default, rows keep OS/online, toggling reveals, edits keep real values', async t => {
  await qml(t, `
  ${remoteClient}
  FloatingWindow {
    visible: true; width: 640; height: 1800
    Plugin.SettingsView { id: settings; client: client; anchors.fill: parent }
  TestCase {
    id: checks; when: false
    function eq(actual, expected, what) { if (actual !== expected) throw Error((what || "") + " expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)) }
    function check(ok, what) { if (!ok) throw Error("check failed: " + what) }
    ${helpers}
    function run() {
      try {
        settings.load()
        wait(50)
        eq(client.privacyMasked, true)
        eq(client.headerTitle, "Gentle Dot · remote")
        var hostField = findChild(settings, "hostField"), hostMask = findChild(settings, "hostMask")
        var portMask = findChild(settings, "portMask"), resultField = findChild(settings, "resultField")
        var eye = findChild(settings, "privacyToggle"), peers = findChild(settings, "peerList")
        check(hostField && hostMask && portMask && resultField && eye && peers, "named items")
        // Masked by default: no host, IP, DNS name, device name or token path anywhere in Settings.
        var text = hidesAll(settings, "masked")
        eq(hostField.visible, false)
        eq(hostMask.visible, true)
        eq(hostMask.readOnly, true)
        eq(hostMask.text, "••••••••")
        eq(resultField.text, "wss://••••••••/ws")
        eq(eye.iconText, "󰈉")
        check(/hidden/i.test(eye.tooltipText), eye.tooltipText)
        // Copying a masked field copies the mask, not the value.
        hostMask.selectAll(); eq(hostMask.selectedText, "••••••••")
        resultField.selectAll(); eq(resultField.selectedText, "wss://••••••••/ws")
        // Device rows: names, DNS names and IPs masked; OS and online state visible.
        var list = rows(peers)
        eq(list.length, 2)
        var first = screen(list[0]), second = screen(list[1])
        check(first.indexOf("macOS") >= 0 && first.indexOf("online") >= 0 && first.indexOf("••••••••") >= 0, first)
        check(second.indexOf("android") >= 0 && second.indexOf("offline") >= 0, second)
        // Test results and messages that carry hosts or URLs.
        client.testState = "failed"
        client.testMessage = "Testing wss://studio-mac.tailnet-example.ts.net/ws…"
        settings.result("Cannot resolve studio-mac. Check the host name.", true)
        wait(20)
        text = hidesAll(settings, "messages")
        check(text.indexOf("Testing wss://••••••••/ws…") >= 0, text)
        check(text.indexOf("Cannot resolve ••••••••. Check the host name.") >= 0, text)
        // Picking a device while masked stores its real address and still shows the mask.
        mouseClick(list[1])
        eq(settings.host, "pixel-seven.tailnet-example.ts.net")
        eq(settings.candidateUrl, "wss://pixel-seven.tailnet-example.ts.net/ws")
        eq(hostMask.text, "••••••••")
        hidesAll(settings, "picked")
        // The eye reveals everything; nothing is saved.
        mouseClick(eye)
        eq(client.privacyMasked, false)
        eq(eye.iconText, "󰈈")
        eq(client.headerTitle, "Gentle Dot · studio-mac.tailnet-example.ts.net")
        eq(hostField.visible, true)
        eq(hostMask.visible, false)
        text = screen(settings)
        check(text.indexOf("pixel-seven.tailnet-example.ts.net") >= 0, text)
        check(text.indexOf("studio-mac · macOS") >= 0 && text.indexOf("   studio-mac.tailnet-example.ts.net") >= 0, text)
        check(text.indexOf("Testing wss://studio-mac.tailnet-example.ts.net/ws…") >= 0, text)
        eq(resultField.text, "wss://pixel-seven.tailnet-example.ts.net/ws")
        // Typing stores the real value; masking again hides it and keeps it.
        hostField.forceActiveFocus()
        hostField.selectAll()
        keyClick("1"); keyClick("0"); keyClick("."); keyClick("0"); keyClick("."); keyClick("0"); keyClick("."); keyClick("5")
        eq(settings.host, "10.0.0.5")
        mouseClick(eye)
        eq(client.privacyMasked, true)
        eq(settings.host, "10.0.0.5")
        eq(settings.candidateUrl, "wss://10.0.0.5/ws")
        eq(resultField.text, "wss://••••••••/ws")
        check(screen(settings).indexOf("10.0.0.5") < 0, screen(settings))
        // Never a settings write, and the live connection is unchanged.
        eq(client.saves, 0)
        eq(client.serverUrl, "wss://studio-mac.tailnet-example.ts.net/ws")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `, { timeout: 20000 });
});

test('privacy: the service masks notices and messages, and re-masks when a panel opens or the last one closes', async t => {
  await qml(t, `
  ${remoteClient}
  QtObject { id: popup }
  QtObject { id: otherMonitor }
  TestCase {
    id: checks; when: false
    function eq(actual, expected, what) { if (actual !== expected) throw Error((what || "") + " expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)) }
    function check(ok, what) { if (!ok) throw Error("check failed: " + what) }
    function run() {
      try {
        eq(client.privacyMasked, true)
        client.showNotice("Upload failed: http://100.64.0.42:4317/upload is down", "error")
        // Paths other than /ws and /health may carry ids or names: hidden too.
        eq(client.displayText(client.notice), "Upload failed: http://••••••••/•••••••• is down")
        client.fatalMessage = "The daemon rejected the token in " + client.tokenFile + "."
        eq(client.displayText(client.fatalMessage), "The daemon rejected the token in ••••••••.")
        eq(client.displayText("Cannot resolve pixel-seven."), "Cannot resolve ••••••••.")
        eq(client.displayUrl(client.serverUrl), "wss://••••••••/ws")
        // Opening a panel masks; another monitor opening or closing keeps the user's choice.
        client.setPrivacyMasked(false)
        client.reportPanelOpen(popup, true)
        eq(client.privacyMasked, true)
        client.setPrivacyMasked(false)
        eq(client.displayText(client.notice), client.notice)
        eq(client.headerTitle, "Gentle Dot · studio-mac.tailnet-example.ts.net")
        client.reportPanelOpen(otherMonitor, true)
        client.reportPanelOpen(otherMonitor, false)
        eq(client.privacyMasked, false)
        // The last open surface closing (popup, pinned panel, detached window) masks again.
        client.reportPanelOpen(popup, false)
        eq(client.privacyMasked, true)
        eq(client.headerTitle, "Gentle Dot · remote")
        // A local connection has no host in the title.
        client.serverUrl = client.localUrl
        eq(client.headerTitle, "Gentle Dot")
        eq(client.saves, 0)
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 50; running: true; onTriggered: checks.run() }
  `);
});
