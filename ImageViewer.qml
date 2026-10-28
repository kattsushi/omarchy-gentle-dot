import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui as Ui

// The image popup's content: the client's viewerImage at its original resolution, scaled
// down to fit, over a dim scrim. Copy and "Attach to message" need the local file, so they
// only appear for images this client has the bytes of. Escape, × or a click outside closes.
FocusScope {
  id: root
  objectName: "imageViewer"

  property var client: null
  readonly property var image: client ? client.viewerImage : null
  readonly property bool local: !!image && image.path !== ""
  // idle | copied | failed
  property string copyState: "idle"
  property color foreground: Commons.Color.foreground
  property string fontFamily: Style.font.family

  visible: image !== null
  focus: true
  onImageChanged: { copyState = "idle"; if (image) forceActiveFocus() }
  Keys.onEscapePressed: function(event) { if (root.client) root.client.closeImage(); event.accepted = true }

  Rectangle {
    anchors.fill: parent
    color: Qt.rgba(0, 0, 0, 0.72)
    MouseArea {
      anchors.fill: parent
      acceptedButtons: Qt.AllButtons
      onClicked: if (root.client) root.client.closeImage()
    }
  }

  Image {
    id: picture
    objectName: "viewerImage"
    anchors.centerIn: parent
    width: parent.width - Style.space(96)
    height: parent.height - Style.space(140)
    source: root.image ? root.image.url : ""
    fillMode: Image.PreserveAspectFit
    asynchronous: true
    cache: false
    smooth: true
    mipmap: true
    // Clicks on the picture itself do not close it.
    MouseArea {
      x: (parent.width - parent.paintedWidth) / 2
      y: (parent.height - parent.paintedHeight) / 2
      width: parent.paintedWidth
      height: parent.paintedHeight
    }
  }

  Text {
    anchors.centerIn: parent
    visible: picture.status === Image.Error
    text: "This image cannot be shown."
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
  }

  Rectangle {
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: parent.bottom
    anchors.bottomMargin: Style.space(24)
    width: bar.implicitWidth + Style.space(16)
    height: bar.implicitHeight + Style.space(8)
    radius: Style.cornerRadius
    color: Commons.Color.popups.background

    Row {
      id: bar
      anchors.centerIn: parent
      spacing: Style.space(6)

      Text {
        objectName: "viewerName"
        anchors.verticalCenter: parent.verticalCenter
        width: Math.min(implicitWidth, root.width * 0.4)
        text: root.image ? root.image.name : ""
        elide: Text.ElideMiddle
        textFormat: Text.PlainText
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: picture.status === Image.Ready
        text: picture.sourceSize.width + " × " + picture.sourceSize.height
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.6)
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
      Ui.PanelActionButton {
        objectName: "viewerCopy"
        visible: root.local
        iconText: root.copyState === "copied" ? "󰄬" : "󰆏"
        tooltipText: root.copyState === "copied" ? "Copied" : (root.copyState === "failed" ? "Copy failed" : "Copy image")
        foreground: root.copyState === "failed" ? Commons.Color.urgent : root.foreground
        fontFamily: "JetBrainsMono Nerd Font"
        onClicked: root.client.copyImage(function(ok) {
          root.copyState = ok ? "copied" : "failed"
          copyReset.restart()
        })
      }
      Ui.PanelActionButton {
        objectName: "viewerAttach"
        visible: root.local
        iconText: "󰏢"
        tooltipText: "Attach to message"
        foreground: root.foreground
        fontFamily: "JetBrainsMono Nerd Font"
        onClicked: root.client.attachViewerImage()
      }
      Ui.PanelActionButton {
        objectName: "viewerClose"
        iconText: "󰅖"
        tooltipText: "Close (Escape)"
        foreground: root.foreground
        hoverColor: Commons.Color.urgent
        fontFamily: "JetBrainsMono Nerd Font"
        onClicked: root.client.closeImage()
      }
    }
  }

  Timer { id: copyReset; interval: 1500; onTriggered: root.copyState = "idle" }
}
