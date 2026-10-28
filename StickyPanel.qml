import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui

// A card-sized surface, not a dismissal overlay. Outside clicks go directly
// to applications; no popout coordinator or focus-loss handler can close it.
PanelWindow {
  id: root

  required property Item anchorItem
  required property QtObject bar
  property bool open: false
  property int contentWidth: 560
  property int contentHeight: 640
  property int padding: Style.spacing.popupPadding
  property color background: Commons.Color.popups.background
  readonly property var anchorWindow: anchorItem ? anchorItem.QsWindow.window : null
  readonly property string barPos: bar ? bar.position : "top"
  readonly property bool verticalBar: barPos === "left" || barPos === "right"
  readonly property real barThickness: anchorWindow
    ? (verticalBar ? anchorWindow.width : anchorWindow.height) : 0
  // Hyprland's general:gaps_out, the gap tiled windows keep from the screen edges and the bar.
  // Omarchy's Style.gapsOut is half of it (the gap its own popups use).
  readonly property real windowGap: Style.gapsOut * 2
  readonly property real edgeInset: barThickness + windowGap
  property alias contentContainer: contentHolder

  screen: anchorWindow ? anchorWindow.screen : null
  visible: open
  color: "transparent"
  exclusionMode: ExclusionMode.Ignore
  implicitWidth: contentWidth
  implicitHeight: contentHeight

  WlrLayershell.namespace: "omarchy-gentle-dot-sticky"
  WlrLayershell.layer: WlrLayer.Overlay
  // Never prime with Exclusive: other windows must remain usable when pinned.
  WlrLayershell.keyboardFocus: open ? WlrKeyboardFocus.OnDemand : WlrKeyboardFocus.None

  anchors {
    top: root.barPos !== "bottom"
    bottom: root.barPos === "bottom"
    left: root.barPos === "left"
    right: root.barPos !== "left"
  }
  margins {
    top: root.barPos === "top" ? root.edgeInset : root.windowGap
    bottom: root.barPos === "bottom" ? root.edgeInset : root.windowGap
    left: root.barPos === "left" ? root.edgeInset : root.windowGap
    right: root.barPos === "right" ? root.edgeInset : root.windowGap
  }

  BorderSurface {
    id: card
    anchors.fill: parent
    color: root.background
    borderSpec: Border.surfaceSpec("popups", "border", Commons.Color.popups.border, Math.max(1, Style.space(2)))
    padding: root.padding
    radius: Style.cornerRadius

    Item {
      id: contentHolder
      anchors.fill: parent
      anchors.topMargin: card.contentTopInset
      anchors.rightMargin: card.contentRightInset
      anchors.bottomMargin: card.contentBottomInset
      anchors.leftMargin: card.contentLeftInset
    }
  }
}
