import QtQuick
import QtQuick.Window
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui

Panel {
  id: root

  moduleName: "omarchy-gentle-dot"
  ipcTarget: "omarchy-gentle-dot"

  readonly property color foreground: bar ? bar.barForeground : Commons.Color.foreground
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.4)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  // The theme's popup background with the user's panel opacity on top of its own alpha.
  readonly property color panelBackground: {
    var base = Commons.Color.popups.background
    return Qt.rgba(base.r, base.g, base.b, base.a * (client ? client.panelOpacity : 0.95))
  }

  // The plugin's shared service (Client.qml): one daemon connection for every
  // monitor's copy of this widget.
  readonly property var client: bar && bar.shell && typeof bar.shell.serviceFor === "function"
    ? bar.shell.serviceFor("omarchy-gentle-dot") : null

  readonly property bool pinned: client ? client.panelPinned : false
  readonly property bool detached: client ? client.detached : false
  readonly property bool ownsDetached: detached && client.detachedOwner === root
  readonly property bool contentOpen: opened || ownsDetached
  readonly property bool settingsOpen: client && client.view === "settings"
  // Popup/sticky: mapped open. Detached: mapped, not minimized, and active.
  readonly property bool notificationVisible: detached
    ? ownsDetached && detachedWindow.backingWindowVisible && !detachedWindow.minimized && detachedWindow.contentContainer.Window.active
    : opened
  onNotificationVisibleChanged: if (client) client.reportPanelVisibility(root, notificationVisible)
  // This panel's chat is on screen (an unfocused detached window counts): the avatar animates only then.
  readonly property bool chatOnScreen: ownsDetached
    ? detachedWindow.backingWindowVisible && !detachedWindow.minimized
    : opened

  // Detached toggle policy: show/unminimize the single existing toplevel,
  // never toggle a popup or hide the window. No compositor focus commands.
  function showDetached() {
    detachedWindow.minimized = false
    detachedWindow.visible = Qt.binding(function() { return root.ownsDetached })
  }

  function open() {
    if (detached) {
      if (!client.detachedOwner) client.detachedOwner = root
      client.detachedOwner.showDetached()
    } else controller.show()
  }

  function toggle() {
    if (detached) open()
    else if (opened) close()
    else open()
  }

  function dock(showPopup) {
    if (!client) return
    client.setDetached(false, null)
    if (showPopup) open()
  }

  // Pinned/detached windows are outside the single-popout lifecycle.
  function closeForPopoutSwitch() {
    if (!pinned && !detached) close()
  }

  function navigatePanel(direction) {
    if (!pinned && !detached) root.switchPanel(direction)
  }

  onDetachedChanged: if (detached) {
    if (opened && !client.detachedOwner) client.detachedOwner = root
    controller.hide()
  }

  Component.onDestruction: {
    if (client) client.reportPanelVisibility(root, false)
    if (client) client.reportPanelOpen(root, false)
    if (client && client.detachedOwner === root) client.setDetached(false, null)
  }

  onPinnedChanged: if (opened) Qt.callLater(function() {
    if (root.opened && panel.focusTarget) panel.focusTarget.forceActiveFocus()
  })
  readonly property string connection: client ? client.connection : "stopped"
  readonly property bool connected: client ? client.connected : false
  readonly property string agentState: connected ? client.agentState : ""
  readonly property string model: client ? client.model : ""
  readonly property bool fatal: connection === "fatal"
  readonly property bool busy: client ? client.busy : false
  readonly property bool needsYou: agentState === "needs_you"
  readonly property bool modelMissing: connected && (model === "" || model === "unknown")
  readonly property color statusColor: {
    if (fatal || needsYou) return urgent
    if (busy) return Commons.Color.accent
    return foreground
  }

  visible: true
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function pushSettings() {
    if (!client) return
    client.configure({
      nodePath: setting("nodePath", "node"),
      serverUrl: setting("serverUrl", "ws://127.0.0.1:4317/ws"),
      tokenFile: setting("tokenFile", "~/.gentle-dot/token"),
      voiceSendOnStop: setting("voiceSendOnStop", false),
      notifications: setting("notifications", true),
      notificationSound: setting("notificationSound", true),
      panelOpacity: setting("panelOpacity", 0.95),
      avatarSleepMinutes: setting("avatarSleepMinutes", 30)
    })
  }

  // The daemon's web UI, where model providers are signed in.
  function webUrl() {
    var url = client ? client.serverUrl : ""
    var match = url.match(/^ws(s?):\/\/([^\/?#]+)/)
    return match ? "http" + match[1] + "://" + match[2] : "http://127.0.0.1:4317"
  }

  function connectionLabel() {
    switch (connection) {
      case "connecting": return "Connecting"
      case "open": return connected ? "Connected" : "Signing in"
      case "reconnecting": return "Reconnecting"
      case "fatal": return "Disconnected"
      default: return client ? "Stopped" : "Starting"
    }
  }

  function agentLabel() {
    switch (agentState) {
      case "starting": return "Starting"
      case "idle": return "Idle"
      case "thinking": return "Thinking"
      case "working": return "Working"
      case "needs_you": return "Needs you"
      case "restarting": return "Restarting"
      case "error": return "Error"
      default: return ""
    }
  }

  function stateLine() {
    var agent = agentLabel()
    return (agent ? connectionLabel() + "  ·  " + agent : connectionLabel()).toUpperCase()
  }

  onClientChanged: {
    pushSettings()
    if (client) client.reportPanelVisibility(root, notificationVisible)
    if (client) client.reportPanelOpen(root, contentOpen)
  }
  onSettingsChanged: pushSettings()
  onOpenedChanged: if (opened) {
    chat.scrollToEnd()
    Qt.callLater(function() {
      if (!root.opened) return
      if (!root.settingsOpen && chat.hasAsks) chat.focusAsk(root.client.pendingAsks[0].requestId)
      else if (panel.focusTarget) panel.focusTarget.forceActiveFocus()
    })
  }

  Connections {
    target: root.client
    function onViewChanged() {
      if (root.contentOpen) Qt.callLater(function() {
        if (root.contentOpen && panel.focusTarget) panel.focusTarget.forceActiveFocus()
      })
    }
    function onAskArrived(requestId) {
      // Never summon or focus a closed panel when the daemon asks for help.
      if (root.opened && !root.settingsOpen && !root.pinned && !root.detached) Qt.callLater(function() {
        if (root.opened && !root.settingsOpen && !root.pinned && !root.detached) chat.focusAsk(requestId)
      })
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // Same rose as the Gentleman theme's menu widget: the emoji only reserves the
    // slot (label hidden), the theme's dual-tone PNG is drawn over it.
    text: "🌹"
    fontFamily: "Noto Color Emoji"
    fontSize: 18
    horizontalMargin: 7.5
    labelVisible: false
    active: root.fatal || root.needsYou || root.busy
    activeColor: root.statusColor
    tooltipText: ""

    Image {
      id: barRose
      anchors.centerIn: parent
      width: 18
      height: 18
      source: "assets/rose-dualtone-136.png"
      fillMode: Image.PreserveAspectFit
      smooth: true
      opacity: root.connected || root.fatal ? 1 : 0.45
    }

    // Status dot: accent while thinking or working, urgent when it needs you or failed.
    Rectangle {
      visible: root.fatal || root.needsYou || root.busy
      width: 6
      height: 6
      radius: 3
      color: root.statusColor
      border.width: 1
      border.color: Commons.Color.background
      anchors.right: barRose.right
      anchors.bottom: barRose.bottom
      anchors.rightMargin: -2
      anchors.bottomMargin: -1
    }

    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton && root.fatal) root.client.restart()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened && !root.pinned && !root.detached
    // Same distance from the bar and the screen edges as tiled windows (Hyprland's gaps_out;
    // Style.gapsOut is half of it), so the chat lines up with the windows next to it.
    margin: Style.gapsOut * 2
    gap: Style.gapsOut * 2
    // Drop the full-screen dismissal surfaces immediately on pin/close, rather
    // than keeping them mapped for the stock card's fade-out animation.
    visible: open
    focusTarget: root.settingsOpen ? settingsView.focusTarget : (chat.askFocusTarget || composer)
    contentWidth: panel.fittedContentWidth(560)
    contentHeight: panel.cappedContentHeight(panel.screenH * 0.65)

    Item {
      id: popupContent
      anchors.fill: parent
    }
  }

  // KeyboardPanel exposes no background property: its card is the BorderSurface that
  // holds the content item (popupContent -> contentHolder -> card).
  Binding {
    target: popupContent.parent && popupContent.parent.parent && "borderSpec" in popupContent.parent.parent
      ? popupContent.parent.parent : null
    property: "color"
    value: root.panelBackground
  }

  StickyPanel {
    id: stickyPanel
    anchorItem: button
    bar: root.bar
    open: root.opened && root.pinned && !root.detached
    contentWidth: panel.contentWidth
    contentHeight: panel.contentHeight
    background: root.panelBackground
  }

  DetachedWindow {
    id: detachedWindow
    open: root.ownsDetached
    initialWidth: panel.contentWidth
    initialHeight: panel.contentHeight
    background: root.panelBackground
    onDockRequested: root.dock(false)
    onBackingWindowVisibleChanged: if (backingWindowVisible && root.ownsDetached) Qt.callLater(function() {
      if (root.ownsDetached && panel.focusTarget) panel.focusTarget.forceActiveFocus()
    })
  }

  // The image popup: a full-screen overlay on this panel's screen while its chat is shown.
  PanelWindow {
    id: viewerWindow
    screen: button.QsWindow.window ? button.QsWindow.window.screen : null
    visible: root.contentOpen && !!root.client && root.client.viewerImage !== null
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "omarchy-gentle-dot-image"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: visible ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
    anchors { top: true; bottom: true; left: true; right: true }

    ImageViewer {
      anchors.fill: parent
      client: root.client
      foreground: root.foreground
      fontFamily: root.fontFamily
    }
  }
  onContentOpenChanged: {
    // Connection details are hidden again whenever the panel opens or closes (S16).
    if (client) client.reportPanelOpen(root, contentOpen)
    if (!contentOpen && client && !client.panelVisible) client.closeImage()
  }

  // The popup's full-screen dismissal layer would sit above the file dialog and close the
  // panel on the first click into it: pin while the dialog is open, then unpin again.
  property bool pinnedForPicker: false
  Connections {
    target: composer
    function onPickerOpenChanged() {
      if (!root.client) return
      if (composer.pickerOpen && root.opened && !root.pinned && !root.detached) {
        root.pinnedForPicker = true
        root.client.setPinned(true)
      } else if (!composer.pickerOpen && root.pinnedForPicker) {
        root.pinnedForPicker = false
        root.client.setPinned(false)
      }
    }
  }

  // Reparent, do not recreate: composer, settings and ask drafts survive modes.
  PanelKeyCatcher {
      id: keyCatcher
      parent: root.ownsDetached ? detachedWindow.contentContainer
        : (root.pinned ? stickyPanel.contentContainer : popupContent)
      anchors.fill: parent
      blocked: root.settingsOpen || composer.activeFocus || chat.hasAsks
      onCloseRequested: {
        if (root.client && root.client.voice.active) root.client.voice.cancel()
        else if (!root.pinned && !root.detached) root.close()
      }
      onTabRequested: function(direction) { root.navigatePanel(direction) }
      onActivateRequested: composer.forceActiveFocus()

      // The avatar's eyes follow the pointer over the chat; when it leaves, they return to the
      // mood's own gaze (nothing asks the compositor where the pointer is).
      HoverHandler {
        id: pointerWatch
        onHoveredChanged: if (!hovered) composer.avatar.pointerLeft()
        onPointChanged: if (hovered) {
          var at = keyCatcher.mapToItem(composer.avatar, point.position.x, point.position.y)
          composer.avatar.pointAt(at.x, at.y)
        }
      }

      Column {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(12)

        PanelHero {
          width: parent.width
          title: root.client ? root.client.headerTitle : "Gentle Dot"
          meta: root.stateLine()
          detail: root.model === "unknown" ? "" : root.model
          foreground: root.foreground
          fontFamily: root.fontFamily


          iconComponent: Component {
            Item {
              implicitWidth: Style.font.display
              implicitHeight: Style.font.display

              Image {
                id: heroRose
                anchors.fill: parent
                source: "assets/rose-dualtone-136.png"
                fillMode: Image.PreserveAspectFit
                smooth: true
                opacity: root.connected || root.fatal ? 1 : 0.45
              }
              Rectangle {
                visible: root.fatal || root.needsYou || root.busy
                width: 8
                height: 8
                radius: 4
                color: root.statusColor
                border.width: 1
                border.color: Commons.Color.background
                anchors.right: heroRose.right
                anchors.bottom: heroRose.bottom
              }
            }
          }
        }

        // Icon-only actions, the same control Omarchy's own panels use for inline actions,
        // aligned to the right edge of the header.
        Row {
          anchors.right: parent.right
          spacing: Style.space(6)

          // Hides or shows hosts, addresses and URLs here and in Settings, for screen sharing.
          PanelActionButton {
            iconText: root.client ? root.client.privacyIcon : ""
            tooltipText: root.client ? root.client.privacyTooltip : ""
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: if (root.client) root.client.setPrivacyMasked(!root.client.privacyMasked)
          }

          PanelActionButton {
            iconText: root.settingsOpen ? "󰁍" : "󰒓"
            tooltipText: root.settingsOpen ? "Back to chat" : "Settings"
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: root.client.view = root.settingsOpen ? "chat" : "settings"
          }

          PanelActionButton {
            visible: !root.detached
            iconText: root.pinned ? "󰐃" : "󰐄"
            tooltipText: root.pinned ? "Unpin (close on outside click)" : "Pin (keep open)"
            foreground: root.pinned ? Commons.Color.accent : root.foreground
            fontFamily: root.fontFamily
            onClicked: if (root.client) root.client.setPinned(!root.pinned)
          }

          PanelActionButton {
            iconText: root.detached ? "󰖲" : "󰏌"
            tooltipText: root.detached ? "Dock back to the bar" : "Detach into a window"
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: {
              if (root.detached) root.dock(true)
              else if (root.client) root.client.setDetached(true, root)
            }
          }

          PanelActionButton {
            iconText: "󰅖"
            tooltipText: "Close"
            foreground: root.foreground
            hoverColor: root.urgent
            fontFamily: root.fontFamily
            onClicked: root.detached ? root.dock(false) : root.close()
          }
        }

        Text {
          visible: !root.settingsOpen && root.modelMissing
          width: parent.width
          text: !root.client ? "" : "Sign in to a model provider in the Gentle Dot web UI (" + root.client.displayUrl(root.webUrl()) + ")"
          color: root.dim
          wrapMode: Text.Wrap
          textFormat: Text.PlainText
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        PanelSeparator {
          foreground: root.foreground
        }
      }

      ChatView {
        id: chat
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.topMargin: Style.space(12)
        anchors.bottom: footer.top
        anchors.bottomMargin: Style.space(8)
        visible: !root.settingsOpen && !root.fatal
        model: root.client ? root.client.messages : null
        client: root.client
        foreground: root.foreground
        accent: Commons.Color.accent
        urgent: root.urgent
        fontFamily: root.fontFamily
      }

      Text {
        visible: !root.settingsOpen && !root.fatal && chat.count === 0 && !chat.hasAsks
        anchors.centerIn: chat
        width: chat.width
        text: root.connected ? "Ask Gentle Dot anything" : (root.client ? root.client.displayUrl(root.client.serverUrl) : "")
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        horizontalAlignment: Text.AlignHCenter
        elide: Text.ElideMiddle
      }

      Column {
        visible: !root.settingsOpen && root.fatal
        anchors.centerIn: chat
        width: chat.width
        spacing: Style.space(12)

        Text {
          width: parent.width
          text: root.client ? root.client.displayText(root.client.fatalMessage) : ""
          color: root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          horizontalAlignment: Text.AlignHCenter
          wrapMode: Text.Wrap
        }

        Button {
          anchors.horizontalCenter: parent.horizontalCenter
          text: "Retry"
          foreground: root.foreground
          fontFamily: root.fontFamily
          bordered: true
          onClicked: root.client.restart()
        }
      }

      SettingsView {
        id: settingsView
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.topMargin: Style.space(12)
        anchors.bottom: parent.bottom
        visible: root.settingsOpen
        client: root.client
        foreground: root.foreground
        urgent: root.urgent
        fontFamily: root.fontFamily
      }

      Column {
        id: footer
        visible: !root.settingsOpen
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        spacing: Style.space(8)

        Text {
          visible: root.client !== null && root.client.notice !== ""
          width: parent.width
          text: root.client ? root.client.displayText(root.client.notice) : ""
          color: root.client && (root.client.noticeLevel === "error" || root.client.noticeLevel === "warning") ? root.urgent : root.dim
          wrapMode: Text.Wrap
          textFormat: Text.PlainText
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Text {
          visible: root.client && (root.client.voice.active || root.client.voice.error !== "")
          width: parent.width
          text: !root.client ? "" : root.client.voice.error || (root.client.voice.state === "recording"
            ? "● Recording · " + root.client.voice.seconds.toFixed(1) + "s · Escape to cancel"
            : root.client.voice.state === "transcribing" ? "Transcribing…"
            : root.client.voice.state === "cancelling" ? "Cancelling…" : "Loading voice…")
          color: root.client && root.client.voice.error ? root.urgent : Commons.Color.accent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          textFormat: Text.PlainText
          wrapMode: Text.Wrap
        }

        Rectangle {
          visible: root.client && root.client.voice.state === "recording"
          width: parent.width
          height: Style.space(4)
          color: root.dim
          Rectangle {
            width: parent.width * Math.min(1, root.client ? root.client.voice.rms * 4 : 0)
            height: parent.height
            color: Commons.Color.accent
          }
        }

        Composer {
          id: composer
          width: parent.width
          client: root.client
          foreground: root.foreground
          urgent: root.urgent
          busy: root.busy
          avatarActive: root.chatOnScreen
          avatarAlpha: root.panelBackground.a
          font.family: root.fontFamily
          onSent: chat.scrollToEnd()
          onEscapePressed: {
            if (root.client && root.client.voice.active) root.client.voice.cancel()
            else if (!root.pinned && !root.detached) root.close()
          }
          onTabPressed: function(direction) { root.navigatePanel(direction) }
        }
      }

      // Files or text dropped anywhere on the chat, in every mode (this content is reparented).
      DropOverlay {
        anchors.fill: parent
        z: 10
        enabled: !root.settingsOpen
        client: root.client
        foreground: root.foreground
        accent: Commons.Color.accent
        fontFamily: root.fontFamily
      }
  }
}
