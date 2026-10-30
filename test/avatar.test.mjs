import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { poll, qml } from './composer-harness.test.mjs';

const helpers = `
  function named(item, name) {
    if (item.objectName === name) return item
    for (var i = 0; i < item.children.length; i++) { var found = named(item.children[i], name); if (found) return found }
    return null
  }
  function insideEye(eye, pupil) {
    return Math.pow((pupil.x - eye.cx) / (eye.rx - pupil.r), 2) + Math.pow((pupil.y - eye.cy) / (eye.ry - pupil.r), 2) <= 1.001
  }
  ${poll}
  // A gesture's shape is checked while that gesture runs, whenever the clock gets there.
  function during(name, condition, message) {
    until(function() { return condition() || avatar.gesture !== name }, 10000, message)
    if (!condition()) throw Error(message + " (during " + name + ")")
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
    // The field and the avatar animate to their new size: checks hold once they have settled.
    function square(what) {
      var avatar = composer.avatar
      if (avatar.width !== composer.fieldHeight || avatar.height !== composer.fieldHeight)
        throw Error(what + ": avatar " + avatar.width + "x" + avatar.height + ", field " + composer.fieldHeight)
    }
    function run() {
      try {
        var avatar = composer.avatar
        var one = 0
        settle(function() {
          one = composer.fieldHeight
          check(one > 0, "field height")
          square("one line")
        })
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
        var many = 0
        settle(function() {
          many = composer.fieldHeight
          check(many > one * 4, "grows with the text: " + many + " vs " + one)
          square("eight lines")
        })
        verify(composer.implicitHeight <= composer.maximumHeight)
        compare(composer.width, 420)

        // A wrapping paragraph: the narrower field and the taller avatar settle together.
        client.draft = Array(30).fill("words").join(" ")
        wait(450)
        settle(function() { square("wrapping paragraph") })

        client.draft = ""
        settle(function() { check(composer.fieldHeight === one, "back to one line: " + composer.fieldHeight); square("empty") })
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
        // The gaze eases towards the pointer: checks hold once it got there.
        avatar.pointAt(-5000, 60)
        verify(avatar.following)
        until(function() { return avatar.leftPupil.x < avatar.leftEye.cx - 2 }, 5000, "looks left")
        until(function() { return avatar.rightPupil.x < avatar.rightEye.cx - 2 }, 5000, "looks left")
        avatar.pointAt(5000, 60)
        until(function() { return avatar.leftPupil.x > avatar.leftEye.cx + 2 }, 5000, "looks right")

        // The pointer leaves the panel: the eyes ease back to the mood's own gaze.
        avatar.pointerLeft()
        verify(!avatar.following, "stops following outside the panel")
        var home = avatar.gazeFrom(avatar.leftEye.cx, avatar.leftEye.cy)
        compare(home.x, rest.x)
        compare(home.y, rest.y)
        until(function() { return Math.abs(avatar.leftGx - rest.x) < 0.01 && Math.abs(avatar.leftGy - rest.y) < 0.01 }, 5000, "left gaze back")
        until(function() { return Math.abs(avatar.rightGx - rest.x) < 0.01 && Math.abs(avatar.rightGy - rest.y) < 0.01 }, 5000, "right gaze back")
        until(function() { return Math.abs(avatar.leftPupil.x - avatar.leftEye.cx) < 0.5 }, 5000, "left pupil centred again")
        // Back over the panel: it follows again.
        avatar.pointAt(-5000, 60)
        verify(avatar.following)
        until(function() { return avatar.leftPupil.x < avatar.leftEye.cx - 2 }, 5000, "follows again")

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
    property real gestureEnd: 0
    Connections {
      target: avatar
      function onBreathChanged() { checks.breathSteps++; checks.peak = Math.max(checks.peak, avatar.breath) }
      function onGestureTimeChanged() { checks.gestureSteps++ }
      // When the gesture ends, taken as it happens (polling would see it late under load).
      function onGesturingChanged() { if (!avatar.gesturing) checks.gestureEnd = Date.now() }
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
        gestureEnd = 0
        avatar.playGesture("grandTwirl")
        var start = Date.now()
        until(function() { return !avatar.gesturing || (avatar.leftMoustache.curl > 0.8 && avatar.rightMoustache.curl > 0.8) }, 5000)
        verify(avatar.leftMoustache.curl > 0.8 && avatar.rightMoustache.curl > 0.8, "both tips twirled")
        until(function() { return !avatar.gesturing }, 10000, "the gesture ends")
        var seconds = (gestureEnd - start) / 1000
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
    ${helpers}
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
        until(function() { return !avatar.typing }, 5000, "rests after the pause")
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
    readonly property var avatar: composer.avatar
    ${helpers}
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
        during("grandTwirl", function() { return avatar.leftMoustache.curl > 0.8 && avatar.rightMoustache.curl > 0.8 }, "both tips twirled")
        mouseClick(avatar)
        compare(avatar.clickVariant, 1)
        compare(avatar.gesture, "shimmy")
        during("shimmy", function() { return Math.abs(avatar.gestureNow.sway) > 1 }, "shimmies sideways")
        mouseClick(avatar)
        compare(avatar.clickVariant, 2)
        compare(avatar.gesture, "cheeky")
        during("cheeky", function() { return Math.abs(avatar.leftMoustache.raise - avatar.rightMoustache.raise) > 0.8 }, "one tip up, the other down")
        verify(composer.editor.activeFocus)
        until(function() { return avatar.reaction === "" }, 5000, "the reaction ends")
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
    ${helpers}
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
        client.handleDaemon(({type: "message_delta", messageId: "m1", delta: "Hi"}))
        compare(avatar.mood, "talking")
        client.agentState = "needs_you"
        compare(avatar.mood, "alert")
        client.agentState = "working"
        client.handleDaemon(({type: "message_done", messageId: "m1", text: "Hi"}))
        compare(avatar.mood, "surprised", "a reply landed while visible")
        until(function() { return avatar.mood !== "surprised" }, 5000, "the surprise ends")
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
        client.handleDaemon(({type: "message_done", messageId: "m2", text: "", error: "boom"}))
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
    ${helpers}
    function curled() { return Math.max(avatar.leftMoustache.curl, avatar.rightMoustache.curl) }
    function run() {
      try {
        // Idle: a proud twirl after a random 10-20 s (scaled down here).
        compare(avatar.mood, "idle")
        verify(avatar.gestureScheduled)
        until(function() { return avatar.gesture === "proud" }, 5000, "proud twirl")
        during("proud", function() { return curled() > 0.8 }, "a tip twirled")

        // Thinking: one tip twirls slowly, over and over.
        client.agentState = "thinking"
        compare(avatar.gesture, "hmm")
        var count = avatar.gestureCount
        during("hmm", function() { return curled() > 0.7 && Math.min(avatar.leftMoustache.curl, avatar.rightMoustache.curl) < curled() - 0.5 }, "hmm twirls only one tip")
        until(function() { return avatar.gestureCount > count && avatar.gesture === "hmm" }, 10000, "hmm loops")

        // Working: a determined twitch every now and then.
        client.agentState = "working"
        verify(avatar.gestureScheduled)
        until(function() { return avatar.lastGesture === "twitch" }, 5000, "a twitch")

        // Streaming: talks, the lip moving irregularly.
        client.handleDaemon(({type: "message_delta", messageId: "m1", delta: "Ciao"}))
        compare(avatar.mood, "talking")
        compare(avatar.gesture, "talk")
        wait(300)
        // Talking moves the moustache (lip lift, each half flapping) without rebuilding its shape.
        var shape = avatar.rightMoustache
        var lifts = 0, flaps = 0
        for (var i = 0; i < 40; i++) {
          if (i % 10 === 0) client.handleDaemon(({type: "message_delta", messageId: "m1", delta: " bella"}))
          wait(20)
          if (avatar.moveLift > 0.15) lifts++
          if (Math.abs(avatar.moveLflap - avatar.moveRflap) > 0.5) flaps++
        }
        verify(lifts > 3, "the lip moves while talking: " + lifts)
        verify(flaps > 3, "the halves flap on their own: " + flaps)
        verify(avatar.rightMoustache === shape, "same outline while talking")
        compare(avatar.gesture, "talk")

        // The reply finished: a satisfied twirl.
        client.handleDaemon(({type: "message_done", messageId: "m1", text: "Ciao bella"}))
        compare(avatar.mood, "surprised")
        compare(avatar.gesture, "listo")
        during("listo", function() { return avatar.leftMoustache.curl > 0.7 && avatar.rightMoustache.curl > 0.7 }, "listo curls both tips")
        wait(1000)

        // Needs you: a cheeky one-side raise.
        client.agentState = "needs_you"
        compare(avatar.mood, "alert")
        compare(avatar.gesture, "cheeky")
        during("cheeky", function() { return Math.abs(avatar.leftMoustache.raise - avatar.rightMoustache.raise) > 0.8 }, "cheeky")

        // A toast: surprise, the moustache puffs out.
        client.handleDaemon(({type: "toast", message: "Heads up", level: "info"}))
        compare(avatar.mood, "surprised")
        compare(avatar.gesture, "puff")
        during("puff", function() { return avatar.rightMoustache.puff > 0.6 }, "puffed")
        wait(1000)

        // An error: a dramatic droop. Mamma mia.
        client.agentState = "idle"
        client.handleDaemon(({type: "message_done", messageId: "m2", text: "", error: "boom"}))
        compare(avatar.mood, "worried")
        compare(avatar.gesture, "mammamia")
        during("mammamia", function() { return avatar.rightMoustache.raise < -1.4 && avatar.leftMoustache.raise < -1.4 }, "dramatic droop")
        avatar.replyFailed = false

        // Recording: attentive, tips up.
        client.voice.state = "recording"
        compare(avatar.mood, "listening")
        compare(avatar.gesture, "perk")
        during("perk", function() { return avatar.rightMoustache.raise > 0.5 && avatar.leftMoustache.raise > 0.5 }, "tips up")
        client.voice.state = "idle"

        // Disconnected: sleepy droop, breathing now and then.
        client.connection = "fatal"
        compare(avatar.mood, "sleepy")
        until(function() { return avatar.lastGesture === "doze" }, 5000, "a doze")
        until(function() { return avatar.rightMoustache.raise < -0.6 }, 5000, "drooping tips")
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
        client.handleDaemon(({type: "message_delta", messageId: "m1", delta: "Hi"}))
        client.handleDaemon(({type: "message_done", messageId: "m1", text: "Hi"}))
        client.handleDaemon(({type: "toast", message: "x", level: "info"}))
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
