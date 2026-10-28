import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { qml } from './composer-harness.test.mjs';

const helpers = `
  function named(item, name) {
    if (item.objectName === name) return item
    for (var i = 0; i < item.children.length; i++) { var found = named(item.children[i], name); if (found) return found }
    return null
  }
  function insideEye(eye, pupil) {
    return Math.pow((pupil.x - eye.cx) / (eye.rx - pupil.r), 2) + Math.pow((pupil.y - eye.cy) / (eye.ry - pupil.r), 2) <= 1.001
  }`;

test('avatar: a square left of the field that follows its height, 1 line to 8 lines, actions intact', async t => {
  await qml(t, `
  Plugin.Client { id: client }
  FloatingWindow {
    visible: true; width: 600; height: 700
    Plugin.Composer { id: composer; client: client; width: 420; y: 200 }
  TestCase {
    id: checks
    name: "AvatarSize"
    when: false
    ${helpers}
    function settle() { wait(450) }
    function run() {
      try {
        settle()
        var avatar = composer.avatar
        var one = composer.fieldHeight
        verify(one > 0)
        compare(avatar.width, one)
        compare(avatar.height, one)
        compare(avatar.x, 0)
        compare(avatar.y + avatar.height, composer.height)
        compare(composer.width, 420)
        var mic = named(composer, "micButton"), attach = named(composer, "attachButton")
        var micAt = mic.mapToItem(composer, 0, 0), attachAt = attach.mapToItem(composer, 0, 0)
        verify(attachAt.x > avatar.width, "attach right of the avatar")
        verify(micAt.x + mic.width <= composer.width, "mic inside the composer")
        var editorAt = composer.editor.mapToItem(composer, 0, 0)
        verify(editorAt.x >= avatar.width, "text starts right of the avatar")

        client.draft = Array(20).fill("wrapped words").join("\\n")
        settle()
        var many = composer.fieldHeight
        verify(many > one * 4, "grows with the text: " + many + " vs " + one)
        verify(composer.implicitHeight <= composer.maximumHeight)
        compare(avatar.height, many)
        compare(avatar.width, many)
        compare(composer.width, 420)

        // A wrapping paragraph: the narrower field and the taller avatar settle together.
        client.draft = Array(30).fill("words").join(" ")
        settle()
        compare(avatar.height, composer.fieldHeight)
        compare(avatar.width, composer.fieldHeight)

        client.draft = ""
        settle()
        compare(avatar.height, one)
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `);
});

test('avatar: pupils follow the pointer over the panel, stay inside the eyes and return when it leaves', async t => {
  await qml(t, `
  Plugin.Client { id: client; connection: "open"; ready: true; agentState: "idle" }
  FloatingWindow {
    visible: true; width: 400; height: 400
    Plugin.Avatar { id: avatar; client: client; width: 120; height: 120; x: 100; y: 100 }
  TestCase {
    id: checks
    name: "AvatarPointer"
    when: false
    ${helpers}
    // Every object the avatar owns, visual or not (timers, animations...).
    function owned(item, out) {
      var list = item.data || item.children || []
      for (var i = 0; i < list.length; i++) { out.push(list[i]); owned(list[i], out) }
      return out
    }
    function run() {
      try {
        compare(avatar.mood, "idle")
        var rest = avatar.restGaze
        var points = [[-5000, 3000], [5000, -5000], [60, -9000], [9000, 60], [60, 60]]
        for (var i = 0; i < points.length; i++) {
          avatar.pointAt(points[i][0], points[i][1])
          wait(400)
          verify(insideEye(avatar.leftEye, avatar.leftPupil), "left inside for " + points[i])
          verify(insideEye(avatar.rightEye, avatar.rightPupil), "right inside for " + points[i])
        }
        avatar.pointAt(-5000, 60)
        wait(400)
        verify(avatar.following)
        verify(avatar.leftPupil.x < avatar.leftEye.cx - 2, "looks left")
        verify(avatar.rightPupil.x < avatar.rightEye.cx - 2, "looks left")
        avatar.pointAt(5000, 60)
        wait(400)
        verify(avatar.leftPupil.x > avatar.leftEye.cx + 2, "looks right")

        // The pointer leaves the panel: the eyes ease back to the mood's own gaze.
        avatar.pointerLeft()
        verify(!avatar.following, "stops following outside the panel")
        wait(500)
        var home = avatar.gazeFrom(avatar.leftEye.cx, avatar.leftEye.cy)
        compare(home.x, rest.x)
        compare(home.y, rest.y)
        verify(Math.abs(avatar.leftGx - rest.x) < 0.01 && Math.abs(avatar.leftGy - rest.y) < 0.01, "left gaze back: " + avatar.leftGx + "," + avatar.leftGy)
        verify(Math.abs(avatar.rightGx - rest.x) < 0.01 && Math.abs(avatar.rightGy - rest.y) < 0.01, "right gaze back")
        verify(Math.abs(avatar.leftPupil.x - avatar.leftEye.cx) < 0.5, "left pupil centred again")
        // Back over the panel: it follows again.
        avatar.pointAt(-5000, 60)
        wait(400)
        verify(avatar.following)
        verify(avatar.leftPupil.x < avatar.leftEye.cx - 2, "follows again")

        // Nothing asks the compositor for the cursor: no process, no command, no poller.
        var objects = owned(avatar, [])
        var timers = objects.filter(function(o) { return o.interval !== undefined && o.repeat !== undefined })
        verify(timers.length > 5, "the walk sees non-visual objects: " + timers.length)
        for (var j = 0; j < objects.length; j++) {
          var o = objects[j]
          verify(o.processId === undefined && o.command === undefined, "no process: " + o)
        }
        compare(avatar.cursorCommand, undefined)
        compare(avatar.pollInterval, undefined)
        compare(avatar.polling, undefined)
        avatar.pointerLeft()
        wait(300)
        verify(!avatar.following)
        avatar.active = false
        verify(!avatar.ticking, "no timers while hidden")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `);
});

test('avatar: slow loops step at most 30 times a second; a breath moves the eyes without rebuilding them', async t => {
  await qml(t, `
  Plugin.Client { id: client; connection: "open"; ready: true; agentState: "idle" }
  FloatingWindow {
    visible: true; width: 400; height: 400
    Plugin.Avatar { id: avatar; client: client; width: 120; height: 120 }
  TestCase {
    id: checks
    name: "AvatarFrameRate"
    when: false
    ${helpers}
    property int breathSteps: 0
    property int gestureSteps: 0
    property real peak: 0
    property real highest: 1000
    Connections {
      target: avatar
      function onBreathChanged() { checks.breathSteps++; checks.peak = Math.max(checks.peak, avatar.breath) }
      function onGestureTimeChanged() { checks.gestureSteps++ }
    }
    function run() {
      try {
        compare(avatar.mood, "idle")
        wait(300)
        // A breath: about 2 s, up and back down, stepped at most 20 times a second.
        var eye = avatar.leftEye, pupil = avatar.leftPupil
        var white = named(avatar, "leftEye")
        var rest = white.mapToItem(avatar, 0, 0).y
        breathSteps = 0
        avatar.breathe()
        var started = Date.now()
        while (Date.now() - started < 2300) {
          wait(25)
          highest = Math.min(highest, white.mapToItem(avatar, 0, 0).y)
        }
        verify(peak > 0.95, "a full breath: " + peak)
        compare(avatar.breath, 0, "back to rest")
        verify(breathSteps <= 2.3 * 20 + 2, "breath steps: " + breathSteps)
        verify(breathSteps >= 20, "still moves smoothly: " + breathSteps)
        verify(rest - highest > 1, "the eyes rise with the breath: " + (rest - highest))
        compare(white.mapToItem(avatar, 0, 0).y, rest)
        verify(avatar.leftEye === eye && avatar.leftPupil === pupil, "no eye or pupil rebuilt by the breath")

        // A moustache gesture: at most 30 steps a second, same keyframes.
        gestureSteps = 0
        avatar.playGesture("grandTwirl")
        var start = Date.now()
        wait(350)
        verify(avatar.leftMoustache.curl > 0.8 && avatar.rightMoustache.curl > 0.8, "both tips twirled")
        tryVerify(function() { return !avatar.gesturing }, 2500)
        var seconds = (Date.now() - start) / 1000
        verify(gestureSteps <= seconds * 30 + 2, "gesture steps: " + gestureSteps + " in " + seconds + " s")
        verify(gestureSteps >= seconds * 15, "still smooth: " + gestureSteps)
        compare(avatar.gestureNow.rc, 0, "settled")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `, { timeout: 20000 });
});

test('avatar: no process or cursor polling in the source', async () => {
  const source = await readFile(new URL('../Avatar.qml', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bProcess\s*\{/, 'no Process');
  assert.doesNotMatch(source, /hyprctl|cursorpos/, 'no hyprctl cursor query');
  assert.doesNotMatch(source, /import Quickshell\.Io/, 'no Quickshell.Io');
  assert.doesNotMatch(source, /pollTimer|cursorReader|calibrat/, 'no poller or calibration');
});

test('avatar: typing in the composer makes it glance and nod, then it rests after the pause', async t => {
  await qml(t, `
  Plugin.Client { id: client; connection: "open"; ready: true; agentState: "idle" }
  FloatingWindow {
    visible: true; width: 600; height: 400
    TextInput { id: elsewhere; width: 50; height: 20 }
    Plugin.Composer { id: composer; client: client; width: 420; y: 200 }
  TestCase {
    id: checks
    name: "AvatarTyping"
    when: false
    function run() {
      try {
        var avatar = composer.avatar
        avatar.typingPause = 500
        compare(avatar.mood, "idle")
        elsewhere.forceActiveFocus()
        client.draft = "dictated"
        wait(50)
        verify(!avatar.typing, "a draft change without focus is not typing")
        compare(avatar.nods, 0)
        client.draft = ""
        composer.forceActiveFocus()
        keyClick(Qt.Key_H)
        verify(avatar.typing)
        compare(avatar.mood, "typing")
        compare(avatar.nods, 1)
        compare(avatar.gesture, "tic", "the moustache twitches with the nod")
        verify(avatar.gaze.x > 0, "glances right, at the field")
        for (var i = 0; i < 4; i++) { keyClick(Qt.Key_A); wait(20) }
        compare(avatar.nods, 1, "no nod per key")
        var started = Date.now()
        for (var j = 0; j < 20; j++) { keyClick(Qt.Key_B); wait(30) }
        var expected = Math.floor((Date.now() - started) / 250)
        verify(avatar.nods >= expected, "keeps nodding while typing fast: " + avatar.nods + " in " + (Date.now() - started) + " ms")
        verify(avatar.typing)
        wait(700)
        verify(!avatar.typing, "rests after the pause")
        compare(avatar.mood, "idle")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `);
});

test('avatar: a click plays a happy reaction (three variants) and gives the focus back to the composer', async t => {
  await qml(t, `
  Plugin.Client { id: client; connection: "open"; ready: true; agentState: "idle" }
  FloatingWindow {
    visible: true; width: 600; height: 400
    TextInput { id: elsewhere; width: 50; height: 20 }
    Plugin.Composer { id: composer; client: client; width: 420; y: 200 }
  TestCase {
    id: checks
    name: "AvatarClick"
    when: false
    function run() {
      try {
        var avatar = composer.avatar
        wait(300)
        elsewhere.forceActiveFocus()
        verify(!composer.editor.activeFocus)
        mouseClick(avatar)
        compare(avatar.reaction, "happy")
        compare(avatar.mood, "happy")
        compare(avatar.clicks, 1)
        compare(avatar.clickVariant, 0)
        compare(avatar.gesture, "grandTwirl")
        verify(composer.editor.activeFocus, "focus returns to the composer")
        wait(350)
        verify(avatar.leftMoustache.curl > 0.8 && avatar.rightMoustache.curl > 0.8, "both tips twirled")
        mouseClick(avatar)
        compare(avatar.clickVariant, 1)
        compare(avatar.gesture, "shimmy")
        wait(70)
        verify(Math.abs(avatar.gestureNow.sway) > 1, "shimmies sideways")
        mouseClick(avatar)
        compare(avatar.clickVariant, 2)
        compare(avatar.gesture, "cheeky")
        wait(300)
        verify(Math.abs(avatar.leftMoustache.raise - avatar.rightMoustache.raise) > 0.8, "one tip up, the other down")
        verify(composer.editor.activeFocus)
        wait(1400)
        compare(avatar.reaction, "")
        compare(avatar.mood, "idle")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `);
});

test('avatar: the mood follows the shared service with no daemon traffic', async t => {
  await qml(t, `
  Plugin.Client {
    id: client
    property var sent: []
    function send(obj) { sent = sent.concat([obj]); return true }
  }
  FloatingWindow {
    visible: true; width: 400; height: 400
    Plugin.Avatar { id: avatar; client: client; width: 80; height: 80 }
  TestCase {
    id: checks
    name: "AvatarMood"
    when: false
    function run() {
      try {
        compare(avatar.mood, "sleepy")
        client.connection = "connecting"
        compare(avatar.mood, "searching")
        client.connection = "open"; client.ready = true; client.agentState = "idle"
        compare(avatar.mood, "idle")
        client.agentState = "thinking"
        compare(avatar.mood, "thinking")
        client.agentState = "working"
        compare(avatar.mood, "focused")
        client.handleLine(JSON.stringify({type: "message_delta", messageId: "m1", delta: "Hi"}))
        compare(avatar.mood, "talking")
        client.agentState = "needs_you"
        compare(avatar.mood, "alert")
        client.agentState = "working"
        client.handleLine(JSON.stringify({type: "message_done", messageId: "m1", text: "Hi"}))
        compare(avatar.mood, "surprised", "a reply landed while visible")
        wait(1100)
        compare(avatar.mood, "focused")
        client.agentState = "idle"
        client.voice.state = "recording"
        compare(avatar.mood, "listening")
        client.voice.state = "transcribing"
        compare(avatar.mood, "pondering")
        client.voice.state = "idle"
        client.uploading = true
        compare(avatar.mood, "busy")
        client.uploading = false
        client.showNotice("The upload failed.", "error")
        compare(avatar.mood, "worried")
        client.notice = ""
        compare(avatar.mood, "idle")
        client.handleLine(JSON.stringify({type: "message_done", messageId: "m2", text: "", error: "boom"}))
        compare(avatar.mood, "worried", "a failed reply")
        client.connection = "fatal"
        compare(avatar.mood, "sleepy")
        verify(avatar.ticking, "sleepy z while visible")
        avatar.active = false
        verify(!avatar.ticking, "nothing runs while hidden")
        compare(client.sent.length, 0)
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `);
});

test('avatar: each mood starts its moustache gesture', async t => {
  await qml(t, `
  Plugin.Client { id: client; connection: "open"; ready: true; agentState: "idle" }
  FloatingWindow {
    visible: true; width: 400; height: 400
    Plugin.Avatar { id: avatar; client: client; width: 120; height: 120; gestureDelayScale: 0.01 }
  TestCase {
    id: checks
    name: "AvatarGestures"
    when: false
    function curled() { return Math.max(avatar.leftMoustache.curl, avatar.rightMoustache.curl) }
    function run() {
      try {
        // Idle: a proud twirl after a random 10-20 s (scaled down here).
        compare(avatar.mood, "idle")
        verify(avatar.gestureScheduled)
        tryCompare(avatar, "gesture", "proud", 1000)
        wait(950)
        verify(curled() > 0.8, "a tip twirled: " + curled())

        // Thinking: one tip twirls slowly, over and over.
        client.agentState = "thinking"
        compare(avatar.gesture, "hmm")
        var count = avatar.gestureCount
        wait(1150)
        verify(curled() > 0.7, "hmm twirl: " + curled())
        verify(Math.min(avatar.leftMoustache.curl, avatar.rightMoustache.curl) < curled() - 0.5, "only one tip")
        tryVerify(function() { return avatar.gestureCount > count && avatar.gesture === "hmm" }, 3000, "hmm loops")

        // Working: a determined twitch every now and then.
        client.agentState = "working"
        verify(avatar.gestureScheduled)
        tryCompare(avatar, "lastGesture", "twitch", 1000)

        // Streaming: talks, the lip moving irregularly.
        client.handleLine(JSON.stringify({type: "message_delta", messageId: "m1", delta: "Ciao"}))
        compare(avatar.mood, "talking")
        compare(avatar.gesture, "talk")
        wait(300)
        // Talking moves the moustache (lip lift, each half flapping) without rebuilding its shape.
        var shape = avatar.rightMoustache
        var lifts = 0, flaps = 0
        for (var i = 0; i < 40; i++) {
          if (i % 10 === 0) client.handleLine(JSON.stringify({type: "message_delta", messageId: "m1", delta: " bella"}))
          wait(20)
          if (avatar.moveLift > 0.15) lifts++
          if (Math.abs(avatar.moveLflap - avatar.moveRflap) > 0.5) flaps++
        }
        verify(lifts > 3, "the lip moves while talking: " + lifts)
        verify(flaps > 3, "the halves flap on their own: " + flaps)
        verify(avatar.rightMoustache === shape, "same outline while talking")
        compare(avatar.gesture, "talk")

        // The reply finished: a satisfied twirl.
        client.handleLine(JSON.stringify({type: "message_done", messageId: "m1", text: "Ciao bella"}))
        compare(avatar.mood, "surprised")
        compare(avatar.gesture, "listo")
        wait(600)
        verify(avatar.leftMoustache.curl > 0.7 && avatar.rightMoustache.curl > 0.7, "listo curls both tips")
        wait(1000)

        // Needs you: a cheeky one-side raise.
        client.agentState = "needs_you"
        compare(avatar.mood, "alert")
        compare(avatar.gesture, "cheeky")
        wait(250)
        verify(Math.abs(avatar.leftMoustache.raise - avatar.rightMoustache.raise) > 0.8, "cheeky")

        // A toast: surprise, the moustache puffs out.
        client.handleLine(JSON.stringify({type: "toast", message: "Heads up", level: "info"}))
        compare(avatar.mood, "surprised")
        compare(avatar.gesture, "puff")
        wait(110)
        verify(avatar.rightMoustache.puff > 0.6, "puffed: " + avatar.rightMoustache.puff)
        wait(1000)

        // An error: a dramatic droop. Mamma mia.
        client.agentState = "idle"
        client.handleLine(JSON.stringify({type: "message_done", messageId: "m2", text: "", error: "boom"}))
        compare(avatar.mood, "worried")
        compare(avatar.gesture, "mammamia")
        wait(550)
        verify(avatar.rightMoustache.raise < -1.4 && avatar.leftMoustache.raise < -1.4, "dramatic droop: " + avatar.rightMoustache.raise)
        avatar.replyFailed = false

        // Recording: attentive, tips up.
        client.voice.state = "recording"
        compare(avatar.mood, "listening")
        compare(avatar.gesture, "perk")
        wait(700)
        verify(avatar.rightMoustache.raise > 0.5 && avatar.leftMoustache.raise > 0.5, "tips up")
        client.voice.state = "idle"

        // Disconnected: sleepy droop, breathing now and then.
        client.connection = "fatal"
        compare(avatar.mood, "sleepy")
        tryCompare(avatar, "lastGesture", "doze", 1000)
        wait(500)
        verify(avatar.rightMoustache.raise < -0.6, "drooping tips")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `, { timeout: 30000 });
});

test('avatar: no moustache gesture runs while the panel is hidden', async t => {
  await qml(t, `
  Plugin.Client { id: client; connection: "open"; ready: true; agentState: "idle" }
  FloatingWindow {
    visible: true; width: 400; height: 400
    Plugin.Avatar { id: avatar; client: client; width: 120; height: 120; gestureDelayScale: 0.01 }
  TestCase {
    id: checks
    name: "AvatarGesturesHidden"
    when: false
    function run() {
      try {
        client.agentState = "thinking"
        verify(avatar.gesturing)
        avatar.active = false
        verify(!avatar.gesturing, "the gesture stops")
        verify(!avatar.gestureScheduled, "no periodic gesture")
        verify(!avatar.ticking)
        var count = avatar.gestureCount
        client.agentState = "idle"
        client.handleLine(JSON.stringify({type: "message_delta", messageId: "m1", delta: "Hi"}))
        client.handleLine(JSON.stringify({type: "message_done", messageId: "m1", text: "Hi"}))
        client.handleLine(JSON.stringify({type: "toast", message: "x", level: "info"}))
        client.agentState = "needs_you"
        client.agentState = "working"
        avatar.playGesture("proud")
        wait(300)
        compare(avatar.gestureCount, count, "nothing started")
        verify(!avatar.gesturing && !avatar.gestureScheduled && !avatar.ticking)
        compare(avatar.gesture, "")
        compare(avatar.gestureNow.rc, 0)
        // Shown again: the mood's gestures come back.
        client.agentState = "thinking"
        avatar.active = true
        compare(avatar.gesture, "hmm")
        avatar.active = false
        verify(!avatar.gesturing)
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `);
});
