import QtQuick
import QtQuick.Controls as Controls
import qs.Commons
import qs.Ui

// A pending protocol Ask. All responses use the service's validated answer path;
// no optimistic removal: other clients and timeouts resolve through the daemon.
FocusScope {
  id: card

  required property var ask
  property var client: null
  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property string fontFamily: Style.font.family
  readonly property bool appOnly: ask.method === "app" || ask.method === "pin"
  readonly property Item focusTarget: appOnly ? null
    : ask.method === "input" ? input
    : ask.method === "editor" ? editor
    : ask.method === "confirm" ? yes
    : options.count > 0 ? options.itemAt(0) : cancel
  property string answerError: ""

  implicitHeight: contents.implicitHeight + Style.space(24)

  function respond(payload) {
    if (!client) return
    var result = client.answer(ask.requestId, payload)
    answerError = result === "sent" ? "" : "Could not answer: " + result
  }

  Rectangle {
    anchors.fill: parent
    radius: Style.cornerRadius
    color: Qt.rgba(card.foreground.r, card.foreground.g, card.foreground.b, 0.06)
    border.color: card.urgent
    border.width: 1
  }

  Column {
    id: contents
    x: Style.space(12)
    y: Style.space(12)
    width: card.width - Style.space(24)
    spacing: Style.space(8)

    Text {
      width: parent.width
      text: String(card.ask.title || "Gentle Dot needs you")
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: card.foreground
      font.family: card.fontFamily
      font.pixelSize: Style.font.body
      font.bold: true
    }

    TextEdit {
      visible: text !== ""
      width: parent.width
      text: String(card.ask.message || "")
      textFormat: TextEdit.MarkdownText
      readOnly: true
      selectByMouse: true
      wrapMode: TextEdit.Wrap
      color: card.foreground
      font.family: card.fontFamily
      font.pixelSize: Style.font.body
      onLinkActivated: function(link) { Qt.openUrlExternally(link) }
    }

    Text {
      visible: card.appOnly
      width: parent.width
      text: "Answer this in the Gentle Dot app"
      wrapMode: Text.Wrap
      color: card.urgent
      font.family: card.fontFamily
      font.pixelSize: Style.font.body
    }

    Column {
      visible: card.ask.method === "select"
      width: parent.width
      spacing: Style.space(6)
      Repeater {
        id: options
        model: card.ask.method === "select" ? (card.ask.options || []) : []
        Button {
          required property string modelData
          width: parent.width
          text: modelData
          foreground: card.foreground
          fontFamily: card.fontFamily
          focusable: true
          bordered: true
          onClicked: card.respond({value: modelData})
        }
      }
    }

    Row {
      visible: card.ask.method === "confirm"
      spacing: Style.space(8)
      Button {
        id: yes
        text: "Yes"
        foreground: card.foreground
        fontFamily: card.fontFamily
        focusable: true
        bordered: true
        onClicked: card.respond({confirmed: true})
      }
      Button {
        text: "No"
        foreground: card.foreground
        fontFamily: card.fontFamily
        focusable: true
        bordered: true
        onClicked: card.respond({confirmed: false})
      }
    }

    TextField {
      id: input
      visible: card.ask.method === "input"
      width: parent.width
      foreground: card.foreground
      font.family: card.fontFamily
      text: String(card.ask.prefill || "")
      placeholderText: String(card.ask.placeholder || "")
      onAccepted: card.respond({value: text})
    }

    Controls.ScrollView {
      visible: card.ask.method === "editor"
      width: parent.width
      height: Style.space(130)
      clip: true
      Controls.TextArea {
        id: editor
        text: String(card.ask.prefill || "")
        placeholderText: String(card.ask.placeholder || "")
        wrapMode: TextEdit.Wrap
        selectByMouse: true
        color: card.foreground
        placeholderTextColor: Qt.darker(card.foreground, 1.4)
        font.family: card.fontFamily
        font.pixelSize: Style.font.body
        background: Rectangle {
          color: "transparent"
          border.color: editor.activeFocus ? card.urgent : Qt.darker(card.foreground, 1.4)
          radius: Style.cornerRadius
        }
      }
    }

    Row {
      visible: !card.appOnly
      spacing: Style.space(8)
      Button {
        visible: card.ask.method === "input" || card.ask.method === "editor"
        text: "Submit"
        foreground: card.foreground
        fontFamily: card.fontFamily
        focusable: true
        bordered: true
        onClicked: card.respond({value: card.ask.method === "editor" ? editor.text : input.text})
      }
      Button {
        id: cancel
        text: "Cancel"
        foreground: card.foreground
        fontFamily: card.fontFamily
        focusable: true
        bordered: true
        onClicked: card.respond({cancelled: true})
      }
    }

    Text {
      visible: text !== ""
      width: parent.width
      text: card.answerError
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: card.urgent
      font.family: card.fontFamily
      font.pixelSize: Style.font.caption
    }
  }
}
