import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import qs.Commons
import qs.Commons as Commons
import qs.Ui as Ui

// One shared draft, even when the same conversation has several UI surfaces.
FocusScope {
  id: root
  required property var client
  property color foreground: Commons.Color.foreground
  property color accent: Commons.Color.accent
  property color urgent: Commons.Color.urgent
  // The assistant is answering: show Stop next to the mic.
  property bool busy: false
  readonly property var voice: client ? client.voice : null
  property alias font: input.font
  readonly property string text: client ? client.draft : ""
  property string placeholderText: "Message Gentle Dot"
  property alias editor: input
  readonly property var attachments: client ? client.attachments : []
  readonly property bool uploading: client ? client.uploading : false
  // Chips and upload status sit above the field and add to its height.
  readonly property real trayHeight: tray.visible ? tray.implicitHeight + Style.space(6) : 0
  readonly property real maximumHeight: trayHeight + metrics.height * 8 + input.topPadding + input.bottomPadding
  // The native file dialog is open (Panel pins the popup meanwhile so the dialog stays usable).
  readonly property bool pickerOpen: picker.visible
  // The Tamagotchi left of the field: square, as tall as the field. It animates only while
  // avatarActive (the panel shows the chat) and uses the panel's background alpha.
  property bool avatarVisible: true
  property bool avatarActive: true
  property real avatarAlpha: 0.95
  readonly property alias avatar: avatar
  readonly property real fieldHeight: field.height
  // The status label on the field's top border (S17), like a fieldset legend, right-aligned
  // (S17.1): it cuts the border with the panel's own background (popups.background at
  // avatarAlpha) and never changes the composer's height.
  property bool statusVisible: true
  property color statusBackground: Qt.rgba(Commons.Color.popups.background.r, Commons.Color.popups.background.g,
    Commons.Color.popups.background.b, root.avatarAlpha)
  readonly property alias statusItem: legendText
  readonly property alias statusDot: legendDot
  readonly property alias statusActions: actions
  readonly property var borderSpec: Border.controlSpec(activeFocus ? "focus" : (input.hovered ? "hover-cursor" : "normal"), foreground, accent)
  signal sent()
  signal escapePressed()
  signal tabPressed(int direction)

  implicitHeight: trayHeight + field.height
  height: implicitHeight
  onActiveFocusChanged: if (activeFocus) input.forceActiveFocus()

  function submit() {
    if (!client) return
    if (client.connection === "fatal") { client.restart(); return }
    if (client.submitDraft()) sent()
  }

  // Overridable in tests, which must never open a real dialog.
  function pickFiles() { picker.open() }
  function pasteText() { input.paste() }

  // QT_QPA_PLATFORMTHEME=gtk3 (Omarchy's default) makes this the native GTK file chooser.
  FileDialog {
    id: picker
    title: "Attach files"
    fileMode: FileDialog.OpenFiles
    onAccepted: if (root.client) root.client.addAttachmentPaths(selectedFiles.map(function(url) { return url.toString() }))
  }

  FontMetrics { id: metrics; font: input.font }

  Column {
    id: tray
    visible: root.attachments.length > 0 || (root.client && root.client.uploadStatus !== "")
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    spacing: Style.space(4)

    Flow {
      width: parent.width
      spacing: Style.space(6)
      Repeater {
        model: root.attachments
        AttachmentChip {
          required property var modelData
          name: modelData.name
          size: modelData.size
          mime: modelData.mime
          path: modelData.path
          removable: !root.uploading
          foreground: root.foreground
          fontFamily: root.font.family
          onRemoved: root.client.removeAttachment(modelData.path)
        }
      }
    }
    Text {
      visible: text !== ""
      width: parent.width
      text: root.client ? root.client.uploadStatus : ""
      color: root.accent
      elide: Text.ElideRight
      textFormat: Text.PlainText
      font.family: root.font.family
      font.pixelSize: Style.font.caption
    }
  }

  Avatar {
    id: avatar
    visible: root.avatarVisible
    client: root.client
    active: root.avatarActive && visible
    backgroundAlpha: root.avatarAlpha
    radius: Style.cornerRadius
    eyeColor: root.foreground
    anchors.left: parent.left
    anchors.bottom: parent.bottom
    // Follows the field with a short animation: a narrower field can wrap into another line,
    // and easing toward it (instead of binding width to height) avoids a binding loop.
    property real size: field.height
    Behavior on size { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }
    width: size
    height: size
    // A click is a reaction, never a focus change: the composer keeps (or gets back) the focus.
    onTapped: input.forceActiveFocus()
  }

  Item {
    id: field
    anchors.left: parent.left
    anchors.leftMargin: avatar.visible ? avatar.width + Style.space(6) : 0
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    height: Math.min(metrics.height * 8, Math.max(metrics.height, input.contentHeight)) + input.topPadding + input.bottomPadding

    Ui.BorderSurface {
      anchors.fill: parent
      color: Style.controlFill(root.activeFocus, input.hovered, root.foreground, root.accent)
      borderSpec: root.borderSpec
      radius: Style.cornerRadius
    }
    ScrollView {
      anchors.fill: parent
      clip: true
      ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
      TextArea {
        id: input
        focus: true
        text: root.text
        onTextChanged: {
          if (root.client && root.client.draft !== text) root.client.draft = text
          if (activeFocus && text !== "") avatar.noteTyping()
        }
        textFormat: TextEdit.PlainText
        wrapMode: TextEdit.Wrap
        selectByMouse: true
        color: root.foreground
        selectionColor: Style.selectionFillFor(root.foreground, root.accent)
        selectedTextColor: root.foreground
        placeholderText: root.placeholderText
        placeholderTextColor: Qt.darker(root.foreground, 1.6)
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        leftPadding: Style.spacing.controlPaddingX + Border.left(root.borderSpec)
        // Leave room for the in-field actions so text never runs under them.
        rightPadding: Style.spacing.controlPaddingX + Border.right(root.borderSpec) + actions.width + Style.space(6)
        topPadding: Style.spacing.inputPaddingY + Border.top(root.borderSpec)
        bottomPadding: Style.spacing.inputPaddingY + Border.bottom(root.borderSpec)
        background: null
        Keys.onEscapePressed: function(event) { root.escapePressed(); event.accepted = true }
        Keys.onTabPressed: function(event) { root.tabPressed(1); event.accepted = true }
        Keys.onBacktabPressed: function(event) { root.tabPressed(-1); event.accepted = true }
        Keys.onPressed: function(event) {
          if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && !(event.modifiers & Qt.ShiftModifier)) {
            root.submit()
            event.accepted = true
          } else if (event.matches(StandardKey.Paste) && root.client) {
            // An image on the clipboard becomes an attachment; text pastes as usual.
            root.client.pasteClipboard(root.pasteText)
            event.accepted = true
          }
        }
      }
    }

    // Mic (and Stop while answering) stay pinned to the field's bottom-right corner,
    // outside the scrolling text, so they remain reachable however long the draft gets.
    Row {
      id: actions
      z: 1
      spacing: Style.space(2)
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      anchors.rightMargin: Style.space(4) + Border.right(root.borderSpec)
      anchors.bottomMargin: Math.max(Style.space(2), (metrics.height + input.topPadding + input.bottomPadding - height) / 2)

      Ui.PanelActionButton {
        objectName: "attachButton"
        iconText: "󰏢"
        tooltipText: "Attach files"
        foreground: root.attachments.length ? root.accent : root.foreground
        enabled: !!root.client && !root.uploading
        onClicked: root.pickFiles()
      }

      Ui.PanelActionButton {
        visible: root.busy
        iconText: "󰙦"
        tooltipText: "Stop the answer"
        foreground: root.urgent
        hoverColor: root.urgent
        onClicked: root.client.abort()
      }

      Ui.PanelActionButton {
        objectName: "micButton"
        readonly property string voiceState: root.voice ? root.voice.state : "idle"
        iconText: voiceState === "recording" ? "󰓛" : (voiceState === "idle" ? "󰍬" : "󰔟")
        tooltipText: voiceState === "recording" ? "Finish and transcribe" : (voiceState === "idle" ? "Dictate" : "Transcribing…")
        foreground: root.voice && root.voice.active ? root.accent : root.foreground
        enabled: !!root.voice && !root.voice.modelBusy && (voiceState === "idle" || voiceState === "recording")
        onClicked: {
          if (voiceState === "recording") root.voice.stop()
          else root.voice.start()
        }
      }
    }
  }

  // Drawn over the field's top border, centred on it and ending where the in-field
  // actions begin; not interactive, so clicks, drops and focus go to the field underneath.
  Item {
    id: legend
    readonly property string target: root.client ? root.client.statusLabel : ""
    readonly property string tone: root.client ? root.client.statusTone : "dim"
    readonly property color toneColor: tone === "urgent" ? root.urgent
      : (tone === "accent" ? root.accent : Qt.darker(root.foreground, 1.4))
    readonly property real padding: Style.space(4)
    visible: root.statusVisible && target !== ""
    z: 2
    // Right edge just before the in-field icons (never over attach/mic); longer text grows left.
    readonly property real rightEdge: field.x + actions.x - Style.space(4)
    x: rightEdge - width
    y: field.y + Border.top(root.borderSpec) / 2 - height / 2
    height: legendText.implicitHeight
    // Elided rather than reaching the avatar, whatever the field's width.
    readonly property real natural: legendText.implicitWidth + (legendDot.visible ? legendDot.width + legendRow.spacing : 0)
    width: Math.max(0, Math.min(natural + padding * 2, rightEdge - field.x - Style.space(10)))

    // Fade out, swap the words, fade back in.
    onTargetChanged: swap.restart()
    SequentialAnimation {
      id: swap
      NumberAnimation { target: legendRow; property: "opacity"; to: 0; duration: 90; easing.type: Easing.InQuad }
      ScriptAction { script: legendText.text = legend.target }
      NumberAnimation { target: legendRow; property: "opacity"; to: 1; duration: 140; easing.type: Easing.OutQuad }
    }

    Rectangle {
      anchors.fill: parent
      radius: height / 2
      color: root.statusBackground
    }

    Row {
      id: legendRow
      x: legend.padding
      width: legend.width - legend.padding * 2
      height: parent.height
      spacing: Style.space(4)
      clip: true

      // A small dot that pulses while the assistant is busy.
      Rectangle {
        id: legendDot
        visible: legend.tone === "accent"
        width: Style.space(5)
        height: width
        radius: width / 2
        anchors.verticalCenter: parent.verticalCenter
        color: legend.toneColor
        SequentialAnimation on opacity {
          running: legendDot.visible && legend.visible && root.avatarActive
          loops: Animation.Infinite
          onRunningChanged: if (!running) legendDot.opacity = 1
          NumberAnimation { to: 0.3; duration: 650; easing.type: Easing.InOutSine }
          NumberAnimation { to: 1; duration: 650; easing.type: Easing.InOutSine }
        }
      }

      Text {
        id: legendText
        // Set by the swap animation from then on.
        Component.onCompleted: text = legend.target
        width: Math.min(implicitWidth, legendRow.width - (legendDot.visible ? legendDot.width + legendRow.spacing : 0))
        anchors.verticalCenter: parent.verticalCenter
        color: legend.toneColor
        elide: Text.ElideRight
        textFormat: Text.PlainText
        font.family: root.font.family
        font.pixelSize: Style.font.caption
      }
    }
  }
}
