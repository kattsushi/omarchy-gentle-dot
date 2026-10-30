import QtQuick
import qs.Ui
import qs.Commons
import qs.Commons as Commons
import "bridge/attachments.mjs" as Attachments

Column {
  id: root
  property string text: ""
  property string label: ""
  property int limit: 40
  property bool expanded: false
  property bool monospace: false
  property bool markdown: false
  property color foreground: Commons.Color.foreground
  readonly property int lineCount: text.split("\n").length
  readonly property bool longContent: label !== "" || lineCount > limit
  // The body text, so a parent can tell where its last line ends.
  property alias textItem: body
  readonly property bool togglesVisible: label === "" && lineCount > limit
  readonly property string shownText: !longContent || expanded ? text : (label ? "" : text.split("\n").slice(0, limit).join("\n"))
  // Markdown goes to Qt's renderer inert (no images, no HTML) whatever was cut (S22.1).
  readonly property string visibleText: markdown ? Attachments.inertMarkdown(shownText) : shownText
  spacing: 4

  component ToggleRow: Rectangle {
    property string title: ""
    width: root.width
    height: Math.max(Style.space(28), titleText.implicitHeight + Style.space(8))
    radius: Style.cornerRadius
    color: toggleMouse.containsMouse ? Style.hoverFillFor(root.foreground, Commons.Color.accent) : "transparent"
    MouseArea {
      id: toggleMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: root.expanded = !root.expanded
    }
    PanelActionButton {
      id: chevron
      anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter
      iconText: root.expanded ? "󰅀" : "󰅂"
      tooltipText: root.expanded ? "Collapse" : "Expand"
      foreground: root.foreground
      fontFamily: "JetBrainsMono Nerd Font"
      onClicked: root.expanded = !root.expanded
    }
    Text {
      id: titleText
      anchors.left: chevron.right; anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      text: parent.title
      textFormat: Text.PlainText
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.72)
      elide: Text.ElideRight
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
    }
  }
  ToggleRow {
    visible: root.label !== ""
    title: root.label
  }
  TextEdit {
    id: body
    width: root.width
    visible: text !== ""
    text: root.visibleText
    readOnly: true
    selectByMouse: true
    wrapMode: TextEdit.Wrap
    textFormat: root.markdown ? TextEdit.MarkdownText : TextEdit.PlainText
    color: root.foreground
    font.family: root.monospace ? "JetBrainsMono Nerd Font" : Style.font.family
    font.pixelSize: Style.font.body
    onLinkActivated: function(link) { if (/^https?:\/\//.test(link)) Qt.openUrlExternally(link) }
  }
  ToggleRow {
    visible: root.togglesVisible
    title: root.expanded ? "Show less" : "Show more"
  }
}
