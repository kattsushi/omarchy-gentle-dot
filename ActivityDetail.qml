import QtQuick
import Quickshell.Io
import qs.Ui
import qs.Commons
import qs.Commons as Commons

// One formatted action detail or output: a bridge `view` (bridge/activity-view.mjs) in the
// small, dim style of the action lines. Code and terminal output reuse CodeBlock (copy, collapse).
Column {
  id: root
  property var view: null
  property color muted: Qt.rgba(Commons.Color.foreground.r, Commons.Color.foreground.g, Commons.Color.foreground.b, 0.65)
  // Injectable command keeps headless tests off the real Wayland clipboard.
  property var clipboardCommand: ["wl-copy"]
  property string copyState: "Copy"
  readonly property string type: view && view.type ? String(view.type) : ""
  readonly property var code: type === "code" ? view : (type === "path" && view.code ? view.code : null)
  readonly property var fieldItems: type === "fields" ? (view.items || []) : (view && view.extra ? view.extra : [])
  readonly property string plainText: type === "text" || type === "fields" ? String(view.text || "") : ""
  spacing: Style.space(3)

  function copy(text) {
    if (clipboard.running) return
    clipboard.pending = text
    clipboard.command = root.clipboardCommand
    clipboard.running = true
  }
  Process {
    id: clipboard
    property string pending: ""
    stdinEnabled: true
    onStarted: { write(pending); stdinEnabled = false }
    onExited: function(exitCode) { root.copyState = exitCode === 0 ? "Copied" : "Copy failed"; stdinEnabled = true }
  }

  Item {
    visible: root.type === "path"
    width: root.width
    height: Math.max(pathText.implicitHeight, pathCopy.height)
    TextEdit {
      id: pathText
      objectName: "detailPath"
      anchors.left: parent.left; anchors.right: pathCopy.left; anchors.rightMargin: Style.space(4)
      anchors.verticalCenter: parent.verticalCenter
      text: root.type === "path" ? String(root.view.path || "") : ""
      textFormat: TextEdit.PlainText
      readOnly: true
      selectByMouse: true
      wrapMode: TextEdit.WrapAnywhere
      color: root.muted
      font.family: "JetBrainsMono Nerd Font"
      font.pixelSize: Style.font.caption
    }
    PanelActionButton {
      id: pathCopy
      objectName: "detailPathCopy"
      anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
      iconText: root.copyState === "Copied" ? "✓" : "󰆏"
      tooltipText: root.copyState
      foreground: root.copyState === "Copy failed" ? Commons.Color.urgent : root.muted
      fontFamily: "JetBrainsMono Nerd Font"
      fontSize: Style.font.caption
      onClicked: root.copy(pathText.text)
    }
  }
  CodeBlock {
    objectName: "detailCode"
    visible: root.code !== null
    width: root.width
    code: root.code ? String(root.code.code || "") : ""
    lang: root.code ? String(root.code.lang || "") : ""
    html: root.code ? String(root.code.html || "") : ""
    fontPixelSize: Style.font.caption
    clipboardCommand: root.clipboardCommand
  }
  Repeater {
    model: root.fieldItems
    TextEdit {
      objectName: "detailField"
      required property var modelData
      width: root.width
      text: String(modelData.key) + ": " + String(modelData.value)
      textFormat: TextEdit.PlainText
      readOnly: true
      selectByMouse: true
      wrapMode: TextEdit.Wrap
      color: root.muted
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
    }
  }
  CodeBlock {
    objectName: "detailTerminal"
    visible: root.type === "terminal"
    width: root.width
    label: "output"
    code: root.type === "terminal" ? String(root.view.text || "") : ""
    color: Qt.darker(Commons.Color.background, 1.45)
    fontPixelSize: Style.font.caption
    clipboardCommand: root.clipboardCommand
  }
  Repeater {
    model: root.type === "list" ? (root.view.items || []) : []
    Item {
      objectName: "detailListItem"
      required property var modelData
      readonly property string text: String(modelData.title || "")
      readonly property string meta: String(modelData.meta || "")
      width: root.width
      height: Math.max(itemTitle.implicitHeight, itemMeta.implicitHeight)
      Text {
        id: itemTitle
        anchors.left: parent.left; anchors.right: itemMeta.left; anchors.rightMargin: Style.space(8)
        text: "• " + parent.text
        textFormat: Text.PlainText
        elide: Text.ElideRight
        color: root.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
      Text {
        id: itemMeta
        anchors.right: parent.right
        width: Math.min(implicitWidth, parent.width * 0.45)
        text: parent.meta
        textFormat: Text.PlainText
        elide: Text.ElideLeft
        color: Qt.rgba(root.muted.r, root.muted.g, root.muted.b, root.muted.a * 0.75)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }
  }
  Text {
    objectName: "detailMore"
    readonly property int more: root.type === "list" ? Number(root.view.more || 0) : 0
    readonly property bool cut: root.type === "list" && !!root.view.cut
    visible: more > 0 || cut
    text: (more > 0 ? "+" + more + " more" : "more") + (cut ? "…" : "")
    color: root.muted
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
  }
  TextEdit {
    objectName: "detailText"
    visible: root.plainText !== ""
    width: root.width
    text: root.plainText
    textFormat: TextEdit.PlainText
    readOnly: true
    selectByMouse: true
    wrapMode: TextEdit.Wrap
    color: root.muted
    font.family: "JetBrainsMono Nerd Font"
    font.pixelSize: Style.font.caption
  }
}
