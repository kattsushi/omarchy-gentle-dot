import QtQuick
import Quickshell
import qs.Commons
import qs.Commons as Commons

// FloatingWindow is an xdg-toplevel, not a layer-shell surface. Hyprland owns
// placement, tiling, resizing, fullscreen and maximize policy. The installed
// Quickshell API has no per-window appId setter (the shell appId is shared).
FloatingWindow {
  id: root

  property bool open: false
  property int initialWidth: 560
  property int initialHeight: 640
  property alias contentContainer: contentHolder
  property color background: Commons.Color.popups.background
  signal dockRequested()

  visible: open
  title: "Gentle Dot"
  implicitWidth: initialWidth
  implicitHeight: initialHeight
  minimumSize: Qt.size(400, 400)
  color: background
  onClosed: dockRequested()

  Item {
    id: contentHolder
    anchors.fill: parent
    anchors.margins: Style.spacing.popupPadding
  }
}
