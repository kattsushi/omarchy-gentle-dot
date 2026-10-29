import test from 'node:test';
import { poll, qml } from './composer-harness.test.mjs';

// The status label on the composer's top border (S17), driven by daemon frames through
// Client.handleLine. send() is replaced, so nothing leaves the harness.
test('status label: ready, thinking, waiting, running command, ODD phase, back to ready; composer height unchanged', async t => {
  await qml(t, `
  Plugin.Client {
    id: client
    entrySettings: ({notifications: false, notificationSound: false})
    notifier.commandPath: "true"
    notifier.soundCommandPath: "true"
    property var sent: []
    function send(obj) { sent = sent.concat([obj]); return true }
  }
  FloatingWindow {
    visible: true; width: 600; height: 400
    Plugin.Composer { id: composer; client: client; width: 420; y: 40 }
    Plugin.Composer { id: plain; client: client; width: 420; y: 200; statusVisible: false }
    Plugin.Composer { id: narrow; client: client; width: 150; y: 300 }
    Plugin.Composer { id: narrowPlain; client: client; width: 150; y: 360; statusVisible: false }
  TestCase {
    id: checks
    name: "StatusLabel"
    when: false
    function frame(obj) { client.handleLine(JSON.stringify(obj)) }
    function named(item, name) {
      if (item.objectName === name) return item
      for (var i = 0; i < item.children.length; i++) { var found = named(item.children[i], name); if (found) return found }
      return null
    }
    // The label ends where the in-field icons begin (never over attach/mic) and grows leftward.
    function rightAligned(c) {
      var item = c.statusItem
      var left = item.mapToItem(c, 0, 0).x
      var right = left + item.width
      var icons = c.statusActions.mapToItem(c, 0, 0).x
      verify(right <= icons, "clear of the icons: label ends at " + right + ", icons start at " + icons)
      verify(icons - right <= 12, "right edge right before the icons: gap " + (icons - right))
      verify(left >= c.avatar.width + 6, "clear of the avatar: " + left)
    }
    ${poll}
    function expect(text, tone) {
      compare(client.statusLabel, text)
      if (tone) compare(client.statusTone, tone)
      // The legend fades to the new text.
      settle(function() {
        if (composer.statusItem.text !== text) throw Error("legend shows " + JSON.stringify(composer.statusItem.text) + ", not " + JSON.stringify(text))
        if (composer.statusItem.opacity !== 1) throw Error("legend opacity " + composer.statusItem.opacity)
      })
    }
    function run() {
      try {
        frame({type: "bridge", state: "open"})
        frame({type: "ready", agentState: "idle", model: "test"})
        frame({type: "history", messages: []})
        expect("ready", "dim")
        verify(composer.statusItem.visible, "the label is shown")
        verify(!plain.statusItem.visible, "statusVisible: false hides it")
        verify(!composer.statusDot.visible, "no pulsing dot while idle")
        // On the field's top border, inside the composer's width and clear of the actions.
        var item = composer.statusItem
        var top = item.mapToItem(composer, 0, 0).y
        var fieldTop = composer.height - composer.fieldHeight
        verify(top < fieldTop && top + item.height > fieldTop, "straddles the top border: " + top + " / " + fieldTop)
        // Right-aligned (S17.1): it ends right where the in-field icons begin, never over them
        // or the avatar.
        rightAligned(composer)
        var attach = named(composer, "attachButton")
        verify(item.mapToItem(composer, 0, 0).x + item.width <= attach.mapToItem(composer, 0, 0).x, "never over the in-field actions")
        // The composer's height, field and avatar are the same with and without the label.
        compare(composer.implicitHeight, plain.implicitHeight)
        compare(composer.fieldHeight, plain.fieldHeight)
        compare(composer.avatar.width, plain.avatar.width)

        frame({type: "agent_state", state: "thinking"})
        expect("thinking", "accent")
        verify(composer.statusDot.visible, "pulsing dot while busy")

        frame({type: "ask", ask: {requestId: "q1", method: "confirm", title: "Run it?"}})
        expect("waiting for you", "urgent")
        frame({type: "ask_resolved", requestId: "q1"})
        expect("thinking")

        frame({type: "message_delta", messageId: "m1", delta: "Hello"})
        expect("answering")
        frame({type: "message_done", messageId: "m1", text: "Hello"})
        expect("thinking")

        // A gentle_odd_phase call (patched daemon) announces the phase on the message already done.
        frame({type: "activity", messageId: "m1", activity: {id: "p1", kind: "other", title: "Working", status: "running",
          tool: "gentle_odd_phase", source: "other", detail: "{\\"phase\\":\\"implementing\\"}"}})
        frame({type: "agent_state", state: "working"})
        expect("implementing")
        frame({type: "activity", messageId: "m1", activity: {id: "p1", kind: "other", title: "Finished", status: "done",
          tool: "gentle_odd_phase", source: "other", detail: "{\\"phase\\":\\"implementing\\"}"}})
        frame({type: "agent_state", state: "thinking"})
        expect("implementing")

        // A running shell command beats the phase; when it ends the phase is back.
        frame({type: "agent_state", state: "working"})
        frame({type: "activity", messageId: "m2", activity: {id: "c1", kind: "run", title: "Running a command", status: "running"}})
        expect("running command", "accent")
        frame({type: "activity", messageId: "m2", activity: {id: "c1", kind: "run", title: "Ran a command", status: "done"}})
        frame({type: "agent_state", state: "thinking"})
        expect("implementing")

        // "clear" clears the phase.
        frame({type: "activity", messageId: "m2", activity: {id: "p2", kind: "other", title: "Working", status: "running",
          tool: "gentle_odd_phase", detail: "{\\"phase\\":\\"clear\\"}"}})
        expect("thinking")
        frame({type: "activity", messageId: "m2", activity: {id: "p3", kind: "other", title: "Working", status: "running",
          tool: "gentle_odd_phase", detail: "{\\"phase\\":\\"checking\\"}"}})
        expect("checking")

        // The turn ends: back to ready, and the phase does not come back with the next turn.
        frame({type: "message_done", messageId: "m3", text: "Done"})
        frame({type: "agent_state", state: "idle"})
        expect("ready", "dim")
        verify(!composer.statusDot.visible)
        frame({type: "agent_state", state: "thinking"})
        expect("thinking")
        frame({type: "agent_state", state: "idle"})
        expect("ready")

        // Losing the connection.
        frame({type: "bridge", state: "reconnecting"})
        expect("reconnecting…", "urgent")
        compare(composer.implicitHeight, plain.implicitHeight)
        rightAligned(composer)
        // A narrow field elides the label instead of running over the avatar.
        rightAligned(narrow)
        compare(narrow.implicitHeight, narrowPlain.implicitHeight)
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 200; running: true; onTriggered: checks.run() }
  }
  `);
});
