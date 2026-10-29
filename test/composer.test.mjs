import test from 'node:test';
import { poll, qml } from './composer-harness.test.mjs';

test('composer: Enter sends once, Shift+Enter edits shared draft, dictation and failed send preserve it', async t => {
  await qml(t, `
  Plugin.Client {
    id: client
    property var sent: []
    property bool allowSend: true
    function send(obj) { if (!allowSend) return false; sent = sent.concat([obj]); return true }
  }
  FloatingWindow {
    visible: true; width: 500; height: 400
    Plugin.Composer {
      id: composer; client: client; width: 300
      property int escapes: 0
      property int tabs: 0
      onEscapePressed: escapes++
      onTabPressed: function(direction) { tabs += direction }
    }
    Plugin.Composer { id: other; client: client; y: 220; width: 300 }
  TestCase {
    id: checks
    name: "Composer"
    when: false
    ${poll}
    function run() {
      try {
        client.connection = "open"; client.ready = true
        client.draft = "hello"
        composer.forceActiveFocus()
        keyClick(Qt.Key_Return)
        compare(client.sent.length, 1)
        compare(client.sent[0].type, "send")
        compare(client.sent[0].text, "hello")
        verify(/^omarchy-/.test(client.sent[0].requestId))
        compare(client.draft, "")
        client.draft = "line"
        composer.editor.cursorPosition = 4
        keyClick(Qt.Key_Return, Qt.ShiftModifier)
        compare(client.draft, "line\\n")
        compare(other.text, "line\\n")
        compare(client.sent.length, 1)
        client.acceptVoiceTranscript("dictation", false)
        compare(composer.text, "line\\ndictation")
        compare(other.text, composer.text)
        client.allowSend = false
        keyClick(Qt.Key_Return)
        compare(client.draft, "line\\ndictation")
        compare(client.sent.length, 1)
        keyClick(Qt.Key_Escape)
        compare(composer.escapes, 1)
        keyClick(Qt.Key_Tab)
        compare(composer.tabs, 1)
        keyClick(Qt.Key_Backtab)
        compare(composer.tabs, 0)
        compare(client.draft, "line\\ndictation")
        const one = composer.implicitHeight
        client.draft = Array(20).fill("wrapped words").join("\\n")
        until(function() { return composer.implicitHeight > one }, 5000, "the composer grows with the text")
        verify(composer.implicitHeight <= composer.maximumHeight)
        verify(composer.editor.wrapMode === TextEdit.Wrap)
        compare(composer.placeholderText, "Message Gentle Dot")
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `);
});
