import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { poll, qml } from './composer-harness.test.mjs';

// The avatar falls asleep after avatarSleepMinutes without activity (S15.6). The clock is faked
// with client.clockOffset (milliseconds added to Date.now()); checkSleep() is what the
// once-a-minute timer and a panel becoming visible run.
const MINUTE = 60000;

const sleepyClient = (extra = '') => `
  Plugin.Client {
    id: client
    connection: "open"; ready: true; agentState: "idle"
    entrySettings: ({avatarSleepMinutes: 30})
    property var saved: null
    shell: QtObject { function updateEntryInline(id, next) { client.saved = next; return true } }
    ${extra}
  }`;

const helpers = `
  function named(item, name) {
    if (item.objectName === name) return item
    for (var i = 0; i < item.children.length; i++) { var found = named(item.children[i], name); if (found) return found }
    return null
  }
  // Pretend the user left: no activity for this many minutes, then the periodic check runs.
  function idleFor(minutes) {
    client.clockOffset = client.lastActivity - Date.now() + minutes * ${MINUTE}
    client.checkSleep()
  }
  function zLetters() {
    var layer = named(avatar, "sleepZ")
    var letters = []
    for (var i = 0; i < layer.children.length; i++) if (layer.children[i].text) letters.push(layer.children[i])
    return { layer: layer, letters: letters }
  }
  ${poll}
  // A reaction (waking up, happy, surprised) has finished.
  function calm() { until(function() { return avatar.reaction === "" }, 10000, "the reaction ends") }`;

test('avatar sleep: falls asleep after the timeout, z letters only while asleep and shown, wakes on a draft change', async t => {
  await qml(t, `
  ${sleepyClient()}
  FloatingWindow {
    visible: true; width: 400; height: 400
    Plugin.Avatar { id: avatar; client: client; width: 120; height: 120; gestureDelayScale: 0.01 }
  TestCase {
    id: checks
    name: "AvatarSleep"
    when: false
    ${helpers}
    function run() {
      try {
        compare(client.avatarSleepMinutes, 30)
        compare(client.sleepCheckInterval, ${MINUTE}, "a coarse check, once a minute")
        idleFor(29)
        verify(!client.asleep, "awake after 29 minutes")
        compare(avatar.mood, "idle")
        verify(!zLetters().layer.visible)

        idleFor(31)
        verify(client.asleep, "asleep after 31 minutes")
        compare(avatar.mood, "asleep")
        until(function() { return avatar.leftEye.open < 0.01 && avatar.rightEye.open < 0.01 }, 5000, "eyes shut")
        verify(!named(avatar, "leftPupil").visible, "no pupils")
        var z = zLetters()
        verify(z.layer.visible, "z letters while asleep")
        compare(z.letters.map(function(l) { return l.text }).join(""), "zzZzZ")
        verify(z.letters[2].font.pixelSize > z.letters[0].font.pixelSize || z.letters[4].font.pixelSize > z.letters[1].font.pixelSize, "small z, bigger Z")
        for (var i = 0; i < z.letters.length; i++) verify(z.letters[i].opacity <= 0.7, "reduced opacity")
        var before = z.letters.map(function(l) { return l.y })
        until(function() { return z.letters.filter(function(l, k) { return l.y < before[k] }).length >= 3 }, 5000, "the letters rise")
        verify(avatar.breathing, "slow breathing")
        until(function() { return avatar.lastGesture === "snooze" }, 5000, "a snooze")
        verify(avatar.ticking)

        // Hidden: nothing animates, no z, still asleep.
        avatar.active = false
        verify(!zLetters().layer.visible, "no z while hidden")
        verify(!avatar.ticking, "nothing runs while hidden")
        verify(!avatar.breathing)
        verify(client.asleep)
        avatar.active = true
        compare(avatar.mood, "asleep")
        verify(zLetters().layer.visible)

        // A typed key / any draft change wakes it with the wake-up reaction.
        var count = avatar.gestureCount
        client.draft = "h"
        verify(!client.asleep, "awake")
        compare(avatar.mood, "waking")
        compare(avatar.gesture, "wakeup")
        verify(avatar.gestureCount > count)
        verify(!zLetters().layer.visible, "no z while waking")
        until(function() { return avatar.leftEye.open > 0.3 }, 5000, "eyes open")
        until(function() { return avatar.mood === "idle" }, 10000, "awake: " + avatar.mood)
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `, { timeout: 20000 });
});

test('avatar sleep: a click wakes it instead of the happy reaction; a new message, the pointer and dictation wake it too', async t => {
  await qml(t, `
  ${sleepyClient()}
  FloatingWindow {
    visible: true; width: 400; height: 400
    Plugin.Avatar { id: avatar; client: client; width: 120; height: 120; x: 20; y: 20 }
  TestCase {
    id: checks
    name: "AvatarWake"
    when: false
    ${helpers}
    function run() {
      try {
        wait(200)
        idleFor(45)
        compare(avatar.mood, "asleep")
        mouseClick(avatar)
        verify(!client.asleep)
        compare(avatar.mood, "waking", "wakes instead of the happy reaction")
        compare(avatar.clicks, 0)
        compare(avatar.gesture, "wakeup")
        until(function() { return avatar.mood === "idle" }, 10000, "awake")
        // Awake, a click is the usual happy reaction (and counts as activity).
        mouseClick(avatar)
        compare(avatar.mood, "happy")
        compare(avatar.clicks, 1)
        calm()

        idleFor(45)
        compare(avatar.mood, "asleep")
        client.handleDaemon(({type: "user_message", messageId: "u1", text: "hola"}))
        verify(!client.asleep, "a new message wakes it")
        compare(avatar.mood, "waking")
        calm()

        idleFor(45)
        client.handleDaemon(({type: "message_delta", messageId: "a1", delta: "Hi"}))
        verify(!client.asleep, "a reply streaming in wakes it")
        client.handleDaemon(({type: "message_done", messageId: "a1", text: "Hi"}))
        calm()

        idleFor(45)
        compare(avatar.mood, "asleep")
        avatar.pointAt(10, 10)
        verify(!client.asleep, "the pointer over the panel wakes it")
        compare(avatar.mood, "waking")
        calm()

        idleFor(45)
        client.voice.state = "loading"
        verify(!client.asleep, "dictation wakes it")
        client.voice.state = "idle"
        calm()

        // A question while asleep: wakes it and the question shows (alert outranks waking).
        idleFor(45)
        client.handleDaemon(({type: "ask", ask: {requestId: "q1", method: "confirm", title: "Go?", timeoutMs: 60000}}))
        verify(!client.asleep)
        compare(avatar.mood, "alert")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `, { timeout: 25000 });
});

test('avatar sleep: counted while hidden, checked when shown; 0 never sleeps; busy states keep it awake; disconnected keeps its own look', async t => {
  await qml(t, `
  ${sleepyClient()}
  FloatingWindow {
    visible: true; width: 400; height: 400
    Plugin.Avatar { id: avatar; client: client; width: 120; height: 120; active: false; x: 20; y: 20 }
  TestCase {
    id: checks
    name: "AvatarSleepRules"
    when: false
    ${helpers}
    function run() {
      try {
        // Inactivity counts while the panel is hidden; showing it checks at once.
        client.clockOffset = client.lastActivity - Date.now() + 40 * ${MINUTE}
        verify(!client.asleep, "not checked yet")
        avatar.active = true
        verify(client.asleep, "checked when the panel became visible")
        compare(avatar.mood, "asleep")
        avatar.active = false
        client.draft = "x"
        verify(!client.asleep)
        client.draft = ""

        // The minute timer runs the check (interval shortened for the test).
        client.sleepCheckInterval = 50
        client.clockOffset = client.lastActivity - Date.now() + 40 * ${MINUTE}
        until(function() { return client.asleep }, 5000, "the periodic check puts it to sleep")
        client.sleepCheckInterval = ${MINUTE}
        client.noteActivity()
        avatar.active = true

        // 0 disables sleep; turning it off wakes a sleeping avatar.
        idleFor(45)
        verify(client.asleep)
        client.entrySettings = ({avatarSleepMinutes: 0})
        verify(!client.asleep, "0: awake")
        idleFor(60 * 24 * 7)
        verify(!client.asleep, "0: never sleeps")
        client.entrySettings = ({avatarSleepMinutes: 30})

        // The agent working, a waiting question, an upload: awake however old the last event is.
        client.agentState = "working"
        idleFor(120)
        verify(!client.asleep, "the agent is working")
        client.agentState = "idle"
        client.uploading = true
        idleFor(120)
        verify(!client.asleep, "an upload is running")
        client.uploading = false
        // Turning sleep off and the agent starting both woke it: let the wake-up finish.
        calm()

        // Disconnected: its own sleepy look (one z), even when the inactivity timer says asleep.
        client.handleBridge(({type: "bridge", state: "fatal", reason: "unauthorized"}))
        compare(avatar.mood, "sleepy")
        idleFor(45)
        verify(client.asleep)
        compare(avatar.mood, "sleepy", "disconnected wins")
        compare(avatar.look.extra, "z")
        verify(!zLetters().layer.visible, "no sleep z letters while disconnected")
        // Reconnecting is activity; the disconnected face just becomes searching (no wake reaction).
        client.handleBridge(({type: "bridge", state: "connecting"}))
        verify(!client.asleep)
        compare(avatar.mood, "searching")
        client.handleBridge(({type: "bridge", state: "open"}))
        client.handleDaemon(({type: "ready", agentState: "idle", model: "m"}))
        compare(avatar.mood, "idle")
        // A click on a disconnected avatar that also timed out is the usual happy reaction.
        client.handleBridge(({type: "bridge", state: "fatal", reason: "unauthorized"}))
        idleFor(45)
        mouseClick(avatar)
        compare(avatar.mood, "happy")
        verify(!client.asleep)
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `, { timeout: 20000 });
});

test('avatar sleep: a key typed in the composer wakes it, then it shows typing', async t => {
  await qml(t, `
  ${sleepyClient()}
  FloatingWindow {
    visible: true; width: 600; height: 400
    Plugin.Composer { id: composer; client: client; width: 420; y: 200 }
  TestCase {
    id: checks
    name: "AvatarTypeToWake"
    when: false
    property var avatar: composer.avatar
    ${helpers}
    function run() {
      try {
        wait(200)
        idleFor(31)
        compare(avatar.mood, "asleep")
        composer.forceActiveFocus()
        keyClick(Qt.Key_H)
        verify(!client.asleep, "a key wakes it")
        compare(avatar.mood, "waking")
        compare(client.draft, "h")
        keyClick(Qt.Key_I)
        until(function() { return avatar.mood === "typing" }, 10000, "typing")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `);
});

test('avatar sleep setting: Settings → Appearance saves it with every other setting; IPC can force sleep for checks', async t => {
  await qml(t, `
  ${sleepyClient()}
  FloatingWindow {
    visible: true; width: 640; height: 1800
    Plugin.SettingsView { id: settings; client: client; anchors.fill: parent }
  TestCase {
    id: checks
    name: "AvatarSleepSetting"
    when: false
    ${helpers}
    function buttons(item, out) {
      out = out || []
      if (!item) return out
      if (item.objectName && item.objectName.indexOf("avatarSleep") === 0) out.push(item)
      var kids = item.children || []
      for (var i = 0; i < kids.length; i++) buttons(kids[i], out)
      if (item.contentItem && kids.indexOf(item.contentItem) < 0) buttons(item.contentItem, out)
      return out
    }
    function run() {
      try {
        client.entrySettings = ({serverUrl: "wss://mac/ws", tokenFile: "~/t", notifications: false, panelOpacity: 0.9})
        compare(client.avatarSleepMinutes, 30, "default")
        var found = buttons(settings)
        compare(found.map(function(b) { return b.objectName }).join(","), "avatarSleep0,avatarSleep15,avatarSleep30,avatarSleep60")
        verify(found[2].text.indexOf("●") === 0, "30 selected: " + found[2].text)
        compare(found[0].text, "Off")
        press(found[1])
        compare(client.saved.avatarSleepMinutes, 15)
        compare(client.saved.serverUrl, "wss://mac/ws")
        compare(client.saved.tokenFile, "~/t")
        compare(client.saved.notifications, false)
        compare(client.saved.panelOpacity, 0.9)
        compare(client.avatarSleepMinutes, 15)
        verify(found[1].text.indexOf("●") === 0)
        press(found[0])
        compare(client.saved.avatarSleepMinutes, 0)
        compare(client.avatarSleepMinutes, 0)
        client.entrySettings = ({avatarSleepMinutes: "nope"})
        compare(client.avatarSleepMinutes, 30, "bad values fall back to 30")

        // Test-only switch (IPC avatarSleep): forces sleep, then any activity wakes it.
        client.forceSleep(true)
        verify(client.asleep)
        client.checkSleep()
        verify(client.asleep, "the periodic check agrees")
        client.forceSleep(false)
        verify(!client.asleep)
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `);
});

test('avatar sleep setting: manifest default and schema, pushed by the panel', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.barWidget.defaults.avatarSleepMinutes, 30);
  const entry = manifest.barWidget.schema.find(s => s.key === 'avatarSleepMinutes');
  assert.ok(entry, 'schema entry');
  assert.equal(entry.type, 'number');
  assert.equal(entry.defaultValue, 30);
  assert.equal(entry.min, 0);
  const panel = await readFile(new URL('../Panel.qml', import.meta.url), 'utf8');
  assert.match(panel, /avatarSleepMinutes: setting\("avatarSleepMinutes", 30\)/);
});
