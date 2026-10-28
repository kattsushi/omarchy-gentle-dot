import QtQuick
import QtQuick.Shapes
import qs.Commons as Commons
import "avatar/mood.mjs" as Mood

// The Tamagotchi next to the composer: two eyes and a moustache on a black square that
// shows the chat's state (avatar/mood.mjs picks the mood, Behaviors morph between them).
// The moustache has gestures of its own (twirls, shimmies, puffs, droops, talking), keyframed
// in avatar/mood.mjs and played by one clock here.
// It only reads the shared service: no daemon traffic. Nothing animates while it is hidden
// (active false); most moods are still pictures with an occasional short animation.
// The eyes follow the pointer only while it is over the panel; outside it they rest.
// After a while without activity it falls asleep (the service decides, client.asleep): shut
// eyes, slow breathing, rising "zzZzZ"; any activity wakes it with a stretch and a shake.
Item {
  id: avatar

  property var client: null
  // The panel's chat is on screen. Timers and loops run only then.
  property bool active: true
  // Black with the panel's own transparency.
  property real backgroundAlpha: 0.95
  property real radius: 0
  property color eyeColor: Commons.Color.foreground
  property color pupilColor: Commons.Color.background
  property color moustacheColor: Qt.rgba(0.94, 0.46, 0.66, 1)
  property int typingPause: 1500
  signal tapped()

  // --- state ------------------------------------------------------------------

  // A momentary reaction: "" | happy (click) | surprised (a reply or toast landed) | waking.
  property string reaction: ""
  // client.asleep, followed by hand (sleepChanged) so the wake-up knows what was on screen.
  property bool sleeping: false
  property int clicks: 0
  property int clickVariant: 0
  property bool typing: false
  property bool typingFast: false
  property int nods: 0
  property real lastKeyAt: 0
  property real lastNodAt: 0
  property bool replyFailed: false
  readonly property bool streaming: streamTimer.running

  readonly property string mood: Mood.mood({
    connection: client ? client.connection : "stopped",
    ready: client ? client.ready : false,
    agentState: client ? client.agentState : "",
    asks: client && client.pendingAsks ? client.pendingAsks.length : 0,
    voice: client && client.voice ? client.voice.state : "idle",
    uploading: client ? client.uploading : false,
    error: replyFailed || (!!client && client.notice !== "" && client.noticeLevel === "error"),
    streaming: streaming,
    typing: typing,
    asleep: sleeping,
    reaction: reaction
  })
  readonly property var look: Mood.expression(mood)
  readonly property bool winking: reaction === "happy" && clickVariant === 1

  // Something is scheduled or looping (tests and the CPU check read this).
  readonly property bool ticking: blinkTimer.running || breathTimer.running || hopTimer.running || pathTimer.running
    || dotsTimer.running || zTimer.running || gestureTimer.running || gestureClock.running
    || sleepTicker.running || wakeAnim.running || breathClock.running
  readonly property bool breathing: sleepTicker.running

  onMoodChanged: {
    pathIndex = 0
    if (active && mood === "alert") hopAnim.restart()
    if (active && mood === "waking") wakeAnim.restart()
    startMoodGesture()
  }
  onActiveChanged: {
    if (!active) {
      typing = false
      blink = 0
      stretch = 0
      sleepBreath = 0
      wakeAnim.stop()
      breathClock.stop()
      breath = 0
      gestureClock.stop()
      gestureData = null
      gestureFrom = null
      gestureTime = 0
    } else {
      // Shown again: the time it spent hidden counts.
      if (client && typeof client.checkSleep === "function") client.checkSleep()
      startMoodGesture()
    }
  }
  onClientChanged: sleepChanged()
  Component.onCompleted: {
    sleepChanged()
    startMoodGesture()
  }

  // Any activity: tell the service (it wakes a sleeping avatar).
  function activity() {
    if (client && typeof client.noteActivity === "function") client.noteActivity()
  }

  function sleepChanged() {
    var now = !!(client && client.asleep)
    if (now === sleeping) return
    // The mood still shows the old state here: wake up only if it was visibly asleep
    // (disconnected keeps its own sleepy look and just changes to the next mood).
    var shown = mood === "asleep"
    sleeping = now
    if (!now && shown) wake()
  }

  // Just woke up: a blink, a stretch and a moustache shake, then the normal mood.
  function wake() {
    if (!active) return
    reaction = "waking"
    reactionTimer.interval = 1400
    reactionTimer.restart()
  }

  function noteTyping() {
    if (!active) return
    var now = Date.now()
    typingFast = now - lastKeyAt < 160
    lastKeyAt = now
    var burstStart = !typing
    typing = true
    typingTimer.restart()
    if (burstStart) blinkAnim.restart()
    if (burstStart || now - lastNodAt >= (typingFast ? 250 : 500)) {
      lastNodAt = now
      nods++
      nodAnim.restart()
      var key = Mood.moustacheGestures(mood).key
      if (key && (!gestureClock.running || gesture === key)) playGesture(key)
    }
  }

  function react() {
    // A sleeping avatar wakes up instead.
    if (mood === "asleep") {
      activity()
      tapped()
      return
    }
    activity()
    clicks++
    clickVariant = (clicks - 1) % 3
    reaction = "happy"
    reactionTimer.interval = 1100
    reactionTimer.restart()
    if (clickVariant === 2) giggleAnim.restart()
    else bounceAnim.restart()
    playGesture(Mood.reactionGesture("click", clickVariant))
    tapped()
  }

  // A reply finished ("reply": a satisfied twirl) or a toast arrived ("toast": a puff).
  function surprise(cause) {
    if (!active || reaction === "happy" || reaction === "waking") return
    reaction = "surprised"
    reactionTimer.interval = 900
    reactionTimer.restart()
    hopAnim.restart()
    playGesture(Mood.reactionGesture(cause || "toast"))
  }

  // --- moustache gestures ---------------------------------------------------------

  // The gesture being played: {name, duration, frames} (Mood.gestureFrames), the offsets it
  // started from (it blends out of them) and how far into it we are.
  property var gestureData: null
  property var gestureFrom: null
  property real gestureTime: 0
  property real gestureStart: 0
  property bool gestureLoops: false
  readonly property var gestureNow: Mood.sampleGesture(gestureData, gestureTime, gestureFrom)
  readonly property string gesture: gestureClock.running && gestureData ? gestureData.name : ""
  readonly property bool gesturing: gestureClock.running
  readonly property bool gestureScheduled: gestureTimer.running
  // For tests: the last gesture started, how many so far, and a scale for the random waits.
  property string lastGesture: ""
  property int gestureCount: 0
  property real gestureDelayScale: 1

  function playGesture(name, loops) {
    if (!active || !name) return
    var from = gestureNow
    gestureClock.stop()
    gestureFrom = from
    gestureData = Mood.gestureFrames(name, Math.random)
    gestureLoops = !!loops
    gestureTime = 0
    lastGesture = name
    gestureCount++
    gestureClock.duration = gestureData.duration
    gestureStart = Date.now()
    gestureClock.restart()
  }

  // A new mood: its entry gesture or its loop; a loop of the last mood settles back to rest
  // (a one-off reaction is left to finish).
  // Reads the mood, not `look`: onMoodChanged can run before `look` is updated.
  function startMoodGesture() {
    if (!active) return
    var m = Mood.moustacheGestures(mood)
    if (gestureTimer.running) {
      gestureTimer.interval = gestureDelay()
      gestureTimer.restart()
    }
    if (m.entry) playGesture(m.entry)
    else if (m.loop) {
      if (!(gestureLoops && gesture === m.loop)) playGesture(m.loop, true)
    } else if (gestureClock.running && gestureLoops) playGesture("settle")
  }

  function gestureDone() {
    if (!active || gestureClock.running) return
    var m = Mood.moustacheGestures(mood)
    if (m.loop) playGesture(m.loop, true)
  }

  function gestureDelay() {
    return Math.max(16, Math.round(Mood.nextDelay(Mood.moustacheGestures(mood).every, Math.random) * gestureDelayScale))
  }

  // --- pointer ----------------------------------------------------------------

  // The pointer over the panel, in this item's coordinates. A layer surface only sees the
  // pointer while it is over it, so outside the panel the eyes go back to the mood's gaze.
  property point pointer: Qt.point(0, 0)
  property bool pointerKnown: false

  // The pointer moved over the panel (x, y in this item's coordinates).
  function pointAt(x, y) {
    activity()
    pointer = Qt.point(x, y)
    pointerKnown = true
  }

  function pointerLeft() { pointerKnown = false }

  // --- face geometry (100 x 100 units) -----------------------------------------

  readonly property real unit: width > 0 ? 100 / width : 1
  property int pathIndex: 0
  readonly property var restGaze: look.path.length ? look.path[pathIndex % look.path.length] : look.gaze
  readonly property bool following: look.follow && pointerKnown

  function gazeFrom(cx, cy) {
    if (following) return Mood.gazeToward(cx, cy, pointer.x * unit, pointer.y * unit, 60)
    return restGaze
  }

  // Animated expression values: Behaviors morph one mood into the next.
  property real leftBase: look.eyes === "open" ? look.open : 0
  property real rightBase: winking ? 1 : leftBase
  property real wide: look.wide
  property real tilt: look.tilt
  property real lift: look.lift
  property real smile: look.smile
  property real curlBase: look.curl
  property real puffBase: look.puff
  property real pupilScale: look.pupil * (mood === "listening" && client && client.voice ? 1 + Math.min(0.25, client.voice.rms * 2) : 1)
  property real happyLeft: look.eyes === "happy" ? 1 : 0
  property real happyRight: look.eyes === "happy" && !winking ? 1 : 0
  Behavior on leftBase { NumberAnimation { duration: 160; easing.type: Easing.OutQuad } }
  Behavior on rightBase { NumberAnimation { duration: 160; easing.type: Easing.OutQuad } }
  Behavior on wide { NumberAnimation { duration: 220; easing.type: Easing.OutBack } }
  Behavior on tilt { NumberAnimation { duration: 220 } }
  Behavior on lift { NumberAnimation { duration: 220; easing.type: Easing.OutQuad } }
  Behavior on smile { NumberAnimation { duration: 260; easing.type: Easing.OutQuad } }
  Behavior on curlBase { NumberAnimation { duration: 260; easing.type: Easing.OutQuad } }
  Behavior on puffBase { NumberAnimation { duration: 260; easing.type: Easing.OutQuad } }
  Behavior on pupilScale { NumberAnimation { duration: 180 } }
  Behavior on happyLeft { NumberAnimation { duration: 140 } }
  Behavior on happyRight { NumberAnimation { duration: 140 } }

  // Momentary animation values.
  property real blink: 0
  property real bodyY: 0
  property real shakeX: 0
  property real breath: 0
  property int dotIndex: 0
  property real zPhase: 0
  // Asleep: breathing (0..1), the rising z letters' clock (0..1, looping); waking: a stretch.
  property real sleepBreath: 0
  property real zClock: 0
  property real stretch: 0

  readonly property var leftEye: ({ cx: 33, cy: 43 + lift, rx: 12.5 * wide, ry: 15 * wide,
    open: Math.max(0, leftBase * (1 - blink)), tilt: tilt, inward: 1, pr: 6 * pupilScale * Math.min(wide, 1.15) })
  readonly property var rightEye: ({ cx: 67, cy: 43 + lift, rx: 12.5 * wide, ry: 15 * wide,
    open: Math.max(0, rightBase * (1 - blink)), tilt: tilt, inward: -1, pr: 6 * pupilScale * Math.min(wide, 1.15) })

  // Gaze is animated, pupils are not: they are recomputed from the gaze and the current eye
  // shape every frame, so they never leave the eye, not even mid-blink.
  readonly property var gaze: gazeFrom(50, leftEye.cy)
  readonly property var leftTarget: gazeFrom(leftEye.cx, leftEye.cy)
  readonly property var rightTarget: gazeFrom(rightEye.cx, rightEye.cy)
  property real leftGx: leftTarget.x
  property real leftGy: leftTarget.y
  property real rightGx: rightTarget.x
  property real rightGy: rightTarget.y
  Behavior on leftGx { NumberAnimation { duration: avatar.following ? 90 : 260; easing.type: Easing.OutQuad } }
  Behavior on leftGy { NumberAnimation { duration: avatar.following ? 90 : 260; easing.type: Easing.OutQuad } }
  Behavior on rightGx { NumberAnimation { duration: avatar.following ? 90 : 260; easing.type: Easing.OutQuad } }
  Behavior on rightGy { NumberAnimation { duration: avatar.following ? 90 : 260; easing.type: Easing.OutQuad } }

  // Each half of the moustache: the mood's pose plus the gesture's offsets. The offsets are
  // split into real properties, which only notify when their value changes: a gesture that
  // only moves the moustache (talking) never rebuilds its outline.
  readonly property real shapeLr: gestureNow.lr
  readonly property real shapeRr: gestureNow.rr
  readonly property real shapeLc: gestureNow.lc
  readonly property real shapeRc: gestureNow.rc
  readonly property real shapePuff: gestureNow.puff
  readonly property real moveSway: gestureNow.sway
  readonly property real moveTilt: gestureNow.tilt
  readonly property real moveLift: gestureNow.lift
  readonly property real moveLflap: gestureNow.lflap
  readonly property real moveRflap: gestureNow.rflap
  readonly property var moustachePose: ({ smile: smile, curl: curlBase, puff: puffBase })
  readonly property var leftMoustache: Mood.moustacheSide(moustachePose, { lr: shapeLr, lc: shapeLc, puff: shapePuff }, -1)
  readonly property var rightMoustache: Mood.moustacheSide(moustachePose, { rr: shapeRr, rc: shapeRc, puff: shapePuff }, 1)

  readonly property var leftPupil: pupilAt(leftEye, leftGx, leftGy)
  readonly property var rightPupil: pupilAt(rightEye, rightGx, rightGy)

  function pupilAt(eye, gx, gy) {
    var offset = Mood.pupilOffset(eye, gx, gy)
    return { x: eye.cx + offset.x, y: eye.cy + offset.y, r: offset.r }
  }

  function closedOpacity(eye, happy) {
    return (1 - happy) * Math.max(0, Math.min(1, (0.2 - eye.open) / 0.12))
  }

  // --- timers and animations (all gated on `active`) -------------------------

  Timer {
    id: blinkTimer
    interval: 3200
    repeat: true
    running: avatar.active && avatar.look.eyes === "open" && avatar.mood !== "sleepy"
    onTriggered: {
      interval = 2400 + Math.random() * 3600
      blinkAnim.restart()
    }
  }
  SequentialAnimation {
    id: blinkAnim
    NumberAnimation { target: avatar; property: "blink"; to: 1; duration: 70; easing.type: Easing.InQuad }
    NumberAnimation { target: avatar; property: "blink"; to: 0; duration: 120; easing.type: Easing.OutQuad }
  }

  // Idle: a slow breath now and then (0.9 s in, 1.1 s out, sine-eased), not a continuous loop.
  // Stepped 20 times a second from the elapsed time instead of every frame: each step repaints
  // the whole panel, and the motion is too slow to need more. It moves the eyes and the
  // moustache with transforms, so no shape is rebuilt.
  Timer {
    id: breathTimer
    interval: 5200
    repeat: true
    running: avatar.active && avatar.look.motion === "breathe"
    onTriggered: avatar.breathe()
  }
  property real breathStart: 0
  function breathe() {
    if (!active) return
    breathStart = Date.now()
    breathClock.restart()
  }
  Timer {
    id: breathClock
    interval: 50
    repeat: true
    onTriggered: {
      var t = Date.now() - avatar.breathStart
      if (t >= 2000) {
        avatar.breath = 0
        stop()
      } else if (t < 900) avatar.breath = 0.5 - 0.5 * Math.cos(Math.PI * t / 900)
      else avatar.breath = 0.5 + 0.5 * Math.cos(Math.PI * (t - 900) / 1100)
    }
  }

  Timer {
    id: hopTimer
    interval: 2200
    repeat: true
    running: avatar.active && avatar.look.motion === "hop"
    onTriggered: hopAnim.restart()
  }
  SequentialAnimation {
    id: hopAnim
    NumberAnimation { target: avatar; property: "bodyY"; to: -5; duration: 130; easing.type: Easing.OutQuad }
    NumberAnimation { target: avatar; property: "bodyY"; to: 0; duration: 240; easing.type: Easing.OutBounce }
  }
  SequentialAnimation {
    id: nodAnim
    NumberAnimation { target: avatar; property: "bodyY"; to: 2.5; duration: 80; easing.type: Easing.OutQuad }
    NumberAnimation { target: avatar; property: "bodyY"; to: 0; duration: 150; easing.type: Easing.InOutQuad }
  }
  SequentialAnimation {
    id: bounceAnim
    NumberAnimation { target: avatar; property: "bodyY"; to: -9; duration: 150; easing.type: Easing.OutQuad }
    NumberAnimation { target: avatar; property: "bodyY"; to: 0; duration: 380; easing.type: Easing.OutBounce }
  }
  SequentialAnimation {
    id: giggleAnim
    loops: 4
    NumberAnimation { target: avatar; property: "shakeX"; to: 3; duration: 45 }
    NumberAnimation { target: avatar; property: "shakeX"; to: -3; duration: 90 }
    NumberAnimation { target: avatar; property: "shakeX"; to: 0; duration: 45 }
  }

  // Gaze paths (searching, thinking, busy): one glance per tick, eased by the gaze Behaviors.
  Timer {
    id: pathTimer
    interval: 800
    repeat: true
    running: avatar.active && avatar.look.path.length > 0 && !avatar.following
    onTriggered: avatar.pathIndex++
  }
  Timer {
    id: dotsTimer
    interval: 340
    repeat: true
    running: avatar.active && avatar.look.extra === "dots"
    onTriggered: avatar.dotIndex = (avatar.dotIndex + 1) % 3
  }
  Timer {
    id: zTimer
    interval: 2600
    repeat: true
    triggeredOnStart: true
    running: avatar.active && avatar.look.extra === "z"
    onTriggered: zAnim.restart()
  }
  NumberAnimation { id: zAnim; target: avatar; property: "zPhase"; from: 0; to: 1; duration: 1400 }

  // Asleep: slow breathing (a 5 s breath) and the rising z letters (7 s each), stepped 20 times
  // a second from the elapsed time instead of every frame: the motion is slow, and transforms
  // and opacity are all it changes, so no shape is rebuilt.
  property real sleepStart: 0
  Timer {
    id: sleepTicker
    interval: 50
    repeat: true
    running: avatar.active && avatar.look.motion === "sleep"
    onRunningChanged: {
      avatar.sleepStart = Date.now()
      if (!running) {
        avatar.sleepBreath = 0
        avatar.zClock = 0
      }
    }
    onTriggered: {
      var t = Date.now() - avatar.sleepStart
      avatar.sleepBreath = 0.5 - 0.5 * Math.cos(2 * Math.PI * t / 5000)
      avatar.zClock = (t % 7000) / 7000
    }
  }
  // Waking up: a blink, a stretch up, another blink.
  SequentialAnimation {
    id: wakeAnim
    ScriptAction { script: blinkAnim.restart() }
    NumberAnimation { target: avatar; property: "stretch"; to: 1; duration: 380; easing.type: Easing.OutQuad }
    PauseAnimation { duration: 180 }
    NumberAnimation { target: avatar; property: "stretch"; to: 0; duration: 340; easing.type: Easing.InOutQuad }
    ScriptAction { script: blinkAnim.restart() }
  }

  // Moustache gestures: one clock through the gesture's eased keyframes, stepped 30 times a
  // second from the elapsed time (each step repaints the whole panel); periodic ones (an idle
  // twirl, a working twitch, a sleepy droop...) after a random wait.
  Timer {
    id: gestureClock
    interval: 33
    repeat: true
    property real duration: 0
    onTriggered: {
      avatar.gestureTime = Math.min(duration, Date.now() - avatar.gestureStart)
      if (avatar.gestureTime >= duration) {
        stop()
        Qt.callLater(avatar.gestureDone)
      }
    }
  }
  Timer {
    id: gestureTimer
    repeat: true
    running: avatar.active && !!avatar.look.moustache.every
    onRunningChanged: if (running) interval = avatar.gestureDelay()
    onTriggered: {
      interval = avatar.gestureDelay()
      if (!gestureClock.running) avatar.playGesture(Mood.moustacheGestures(avatar.mood).gesture)
    }
  }

  Timer { id: typingTimer; interval: avatar.typingPause; onTriggered: avatar.typing = false }
  Timer { id: reactionTimer; interval: 1100; onTriggered: avatar.reaction = "" }
  Timer { id: streamTimer; interval: 900 }
  Timer { id: failTimer; interval: 4000; onTriggered: avatar.replyFailed = false }

  Connections {
    target: avatar.client
    ignoreUnknownSignals: true
    function onAsleepChanged() { avatar.sleepChanged() }
    function onMessage(msg) {
      if (msg.type === "message_delta") streamTimer.restart()
      else if (msg.type === "message_done") {
        streamTimer.stop()
        if (msg.error) {
          avatar.replyFailed = true
          failTimer.restart()
        } else if (!msg.stopped) avatar.surprise("reply")
      } else if (msg.type === "toast") avatar.surprise("toast")
    }
  }

  // --- drawing ------------------------------------------------------------------

  Rectangle {
    anchors.fill: parent
    radius: avatar.radius
    color: Qt.rgba(0, 0, 0, avatar.backgroundAlpha)
    border.width: 1
    border.color: Qt.rgba(avatar.eyeColor.r, avatar.eyeColor.g, avatar.eyeColor.b, 0.12)
  }

  Item {
    id: viewport
    anchors.fill: parent
    clip: true

    Item {
      id: face
      width: 100
      height: 100
      scale: avatar.width / 100
      transformOrigin: Item.TopLeft
      x: avatar.shakeX * scale
      y: avatar.bodyY * scale
      // Sleeping breath and the wake-up stretch, about the bottom of the face.
      transform: Scale {
        origin.x: 50
        origin.y: 92
        xScale: 1 + 0.015 * avatar.sleepBreath - 0.04 * avatar.stretch
        yScale: 1 + 0.035 * avatar.sleepBreath + 0.08 * avatar.stretch
      }

      component EyeWhite: Shape {
        id: eyeShape
        property var eye
        anchors.fill: parent
        preferredRendererType: Shape.CurveRenderer
        ShapePath {
          fillColor: avatar.eyeColor
          strokeWidth: -1
          PathSvg { path: Mood.eyePath(eyeShape.eye) }
        }
      }
      component Pupil: Shape {
        id: pupilShape
        property var pupil
        anchors.fill: parent
        preferredRendererType: Shape.CurveRenderer
        ShapePath {
          fillColor: avatar.pupilColor
          strokeWidth: -1
          PathAngleArc { centerX: pupilShape.pupil.x; centerY: pupilShape.pupil.y; radiusX: pupilShape.pupil.r; radiusY: pupilShape.pupil.r; startAngle: 0; sweepAngle: 360 }
        }
        ShapePath {
          fillColor: avatar.eyeColor
          strokeWidth: -1
          PathAngleArc {
            centerX: pupilShape.pupil.x - pupilShape.pupil.r * 0.38; centerY: pupilShape.pupil.y - pupilShape.pupil.r * 0.38
            radiusX: pupilShape.pupil.r * 0.3; radiusY: pupilShape.pupil.r * 0.3; startAngle: 0; sweepAngle: 360
          }
        }
      }
      // Shut eye "‿" and happy eye "^": strokes in the eye colour.
      component EyeStroke: Shape {
        id: stroke
        property string svg
        anchors.fill: parent
        preferredRendererType: Shape.CurveRenderer
        visible: opacity > 0.01
        ShapePath {
          fillColor: "transparent"
          strokeColor: avatar.eyeColor
          strokeWidth: 3.6
          capStyle: ShapePath.RoundCap
          PathSvg { path: stroke.svg }
        }
      }
      component MoustacheHalf: Shape {
        id: half
        property int side: 1
        property var params
        // Turns the tip up (> 0) about the middle of the lip.
        property real flap: 0
        anchors.fill: parent
        preferredRendererType: Shape.CurveRenderer
        transform: Rotation { origin.x: 50; origin.y: 71; angle: -half.side * half.flap }
        ShapePath {
          fillColor: avatar.moustacheColor
          fillRule: ShapePath.WindingFill
          strokeWidth: -1
          PathSvg { path: Mood.moustachePath(half.side, half.params) }
        }
      }

      // The eyes; a breath lifts them as a whole.
      Item {
        objectName: "eyes"
        anchors.fill: parent
        transform: Translate { y: -avatar.breath * 1.2 }

        EyeWhite { objectName: "leftEye"; eye: avatar.leftEye; visible: avatar.leftEye.open > 0.01 }
        EyeWhite { objectName: "rightEye"; eye: avatar.rightEye; visible: avatar.rightEye.open > 0.01 }
        Pupil { objectName: "leftPupil"; pupil: avatar.leftPupil; visible: avatar.leftEye.open > 0.12 }
        Pupil { objectName: "rightPupil"; pupil: avatar.rightPupil; visible: avatar.rightEye.open > 0.12 }

        EyeStroke {
          opacity: avatar.closedOpacity(avatar.leftEye, avatar.happyLeft)
          svg: "M " + (avatar.leftEye.cx - 10) + " " + (avatar.leftEye.cy + 2) + " Q " + avatar.leftEye.cx + " " + (avatar.leftEye.cy + 10) + " " + (avatar.leftEye.cx + 10) + " " + (avatar.leftEye.cy + 2)
        }
        EyeStroke {
          opacity: avatar.closedOpacity(avatar.rightEye, avatar.happyRight)
          svg: "M " + (avatar.rightEye.cx - 10) + " " + (avatar.rightEye.cy + 2) + " Q " + avatar.rightEye.cx + " " + (avatar.rightEye.cy + 10) + " " + (avatar.rightEye.cx + 10) + " " + (avatar.rightEye.cy + 2)
        }
        EyeStroke {
          opacity: avatar.happyLeft
          svg: "M " + (avatar.leftEye.cx - 10) + " " + (avatar.leftEye.cy + 5) + " Q " + avatar.leftEye.cx + " " + (avatar.leftEye.cy - 14) + " " + (avatar.leftEye.cx + 10) + " " + (avatar.leftEye.cy + 5)
        }
        EyeStroke {
          opacity: avatar.happyRight
          svg: "M " + (avatar.rightEye.cx - 10) + " " + (avatar.rightEye.cy + 5) + " Q " + avatar.rightEye.cx + " " + (avatar.rightEye.cy - 14) + " " + (avatar.rightEye.cx + 10) + " " + (avatar.rightEye.cy + 5)
        }
      }

      Item {
        anchors.fill: parent
        // Positive tilt turns clockwise: the right tip goes down, the left tip goes up.
        transform: [
          Rotation { origin.x: 50; origin.y: 70; angle: avatar.moveTilt },
          Translate { x: avatar.moveSway; y: avatar.breath * 0.8 - avatar.moveLift * 2.4 }
        ]
        MoustacheHalf { objectName: "rightMoustache"; side: 1; params: avatar.rightMoustache; flap: avatar.moveRflap }
        MoustacheHalf { objectName: "leftMoustache"; side: -1; params: avatar.leftMoustache; flap: avatar.moveLflap }
      }

      // Extras: thinking dots, a sleepy z, an alert mark.
      Row {
        visible: avatar.look.extra === "dots"
        x: 38
        y: 9
        spacing: 3
        Repeater {
          model: 3
          Shape {
            required property int index
            width: 6
            height: 6
            preferredRendererType: Shape.CurveRenderer
            opacity: index === avatar.dotIndex ? 1 : 0.3
            Behavior on opacity { NumberAnimation { duration: 150 } }
            ShapePath {
              fillColor: avatar.eyeColor
              strokeWidth: -1
              PathAngleArc { centerX: 3; centerY: 3; radiusX: 3; radiusY: 3; startAngle: 0; sweepAngle: 360 }
            }
          }
        }
      }
      Text {
        visible: avatar.look.extra === "z"
        text: "z"
        renderType: Text.QtRendering
        color: avatar.eyeColor
        font.pixelSize: 14 + avatar.zPhase * 6
        font.bold: true
        x: 74 + avatar.zPhase * 10
        y: 22 - avatar.zPhase * 20
        opacity: Math.sin(Math.PI * avatar.zPhase)
      }
      // Asleep: "zzZzZ" rising from beside the eyes, drifting, growing and fading, staggered.
      // Theme foreground at reduced opacity; the viewport clips them to the box.
      Item {
        objectName: "sleepZ"
        anchors.fill: parent
        visible: avatar.active && avatar.look.extra === "zzz"
        Repeater {
          model: ["z", "z", "Z", "z", "Z"]
          Text {
            required property string modelData
            required property int index
            readonly property real phase: (avatar.zClock + index / 5) % 1
            text: modelData
            renderType: Text.QtRendering
            color: avatar.eyeColor
            font.bold: true
            // A fixed size grown with scale: changing the font size would lay the text out
            // again every frame.
            font.pixelSize: modelData === "Z" ? 14 : 10
            scale: 0.65 + 0.55 * phase
            transformOrigin: Item.BottomLeft
            x: 64 + phase * 20 + Math.sin((phase * 2 + index * 0.4) * Math.PI) * 3.5
            y: 30 - phase * 38
            opacity: 0.6 * Math.min(1, phase / 0.15) * Math.min(1, (1 - phase) / 0.35)
          }
        }
      }
      Text {
        visible: avatar.look.extra === "!"
        text: "!"
        renderType: Text.QtRendering
        color: avatar.moustacheColor
        font.pixelSize: 20
        font.bold: true
        x: 85
        y: 5
      }
    }
  }

  TapHandler {
    onTapped: avatar.react()
  }
}
