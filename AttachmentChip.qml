import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui as Ui
import "bridge/attachments.mjs" as Attachments

// One file as a small chip: thumbnail (local images only), name, size, an optional muted
// note ("preview unavailable") and, in the composer, a remove ×.
Rectangle {
  id: chip
  objectName: "attachmentChip"

  property string name: ""
  property real size: 0
  property string mime: ""
  // Local file, when this client has the bytes; empty for history from elsewhere.
  property string path: ""
  property string note: ""
  property bool removable: false
  property color foreground: Commons.Color.foreground
  property string fontFamily: Style.font.family
  property real maximumWidth: Style.space(240)
  readonly property bool preview: path !== "" && Attachments.isImage(mime)
  readonly property color muted: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.6)
  signal removed()

  width: Math.min(maximumWidth, row.implicitWidth + Style.space(12))
  height: Math.max(Style.space(30), row.implicitHeight + Style.space(8))
  radius: Style.cornerRadius
  color: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.08)

  Row {
    id: row
    x: Style.space(6)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(6)

    Image {
      objectName: "chipThumb"
      visible: chip.preview
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(24)
      height: Style.space(24)
      source: chip.preview ? "file://" + encodeURI(chip.path) : ""
      sourceSize.width: 64
      sourceSize.height: 64
      fillMode: Image.PreserveAspectCrop
      asynchronous: true
      cache: true
    }
    Text {
      visible: !chip.preview
      anchors.verticalCenter: parent.verticalCenter
      text: Attachments.isImage(chip.mime) ? "󰋩" : "󰈔"
      color: chip.muted
      font.family: "JetBrainsMono Nerd Font"
      font.pixelSize: Style.font.caption + 2
    }
    Column {
      anchors.verticalCenter: parent.verticalCenter
      Text {
        objectName: "chipName"
        width: Math.min(implicitWidth, chip.maximumWidth - Style.space(90))
        text: chip.name
        elide: Text.ElideMiddle
        textFormat: Text.PlainText
        color: chip.foreground
        font.family: chip.fontFamily
        font.pixelSize: Style.font.caption
      }
      Row {
        spacing: Style.space(6)
        Text {
          objectName: "chipSize"
          text: Attachments.formatSize(chip.size)
          textFormat: Text.PlainText
          color: chip.muted
          font.family: chip.fontFamily
          font.pixelSize: Style.font.caption - 1
        }
        Text {
          objectName: "chipNote"
          visible: text !== ""
          text: chip.note
          textFormat: Text.PlainText
          color: chip.muted
          font.family: chip.fontFamily
          font.pixelSize: Style.font.caption - 1
          font.italic: true
        }
      }
    }
    Ui.PanelActionButton {
      objectName: "chipRemove"
      visible: chip.removable
      anchors.verticalCenter: parent.verticalCenter
      iconText: "󰅖"
      tooltipText: "Remove " + chip.name
      foreground: chip.muted
      hoverColor: Commons.Color.urgent
      fontFamily: "JetBrainsMono Nerd Font"
      fontSize: Style.font.caption + 1
      onClicked: chip.removed()
    }
  }
}
