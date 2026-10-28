import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui as Ui
import "bridge/time-format.mjs" as TimeFormat
import "bridge/attachments.mjs" as Attachments

// Right-aligned user bubble and rose-tinted assistant card, each with its time in the side
// gutter. Raw text remains separate from bridge-rendered segments so copying never copies
// highlight HTML.
Item {
  id: bubble

  // Model roles (see Client.qml messages).
  required property string role
  required property string text
  required property string phase
  required property string error
  required property string activities
  property string segments: "[]"
  property string reasoning: ""
  // JSON [{name, size, mime, path?, uploadId?, loading?, reason?}] (Client.attachmentsJson): `path`
  // for files this client attached or the bridge cached, `uploadId` for files a patched daemon serves.
  property string attachments: "[]"
  readonly property var attachmentList: {
    try {
      var list = JSON.parse(attachments)
      return Array.isArray(list) ? list : []
    } catch (e) {
      return []
    }
  }
  // {path, url, name, mime}: the chat opens it in the image viewer.
  signal openImage(var image)
  // An attachment row: the chat opens its file (fetched first when only the daemon has it).
  signal openFile(var file)
  // Milliseconds (0 = unknown: no label) and the shared clock it is shown against.
  property real at: 0
  property real now: Date.now()
  readonly property string timeText: TimeFormat.relativeTime(at, now)
  readonly property bool canCopy: phase !== "streaming" && text !== ""
  readonly property color rose: Qt.rgba(0.94, 0.46, 0.66, 1)
  readonly property color assistantTint: Qt.rgba(rose.r, rose.g, rose.b, 0.12)
  // idle | copied | failed. Injectable command keeps headless tests off the real clipboard.
  property string copyState: "idle"
  property var clipboardCommand: ["wl-copy"]
  // Markdown images leave the prose (Qt's renderer would fetch any scheme): https and local
  // ones become image segments, the rest keep only their alt text.
  readonly property var renderedSegments: {
    var list = text ? [{type:"md", text:text}] : []
    try {
      var parsed = JSON.parse(segments)
      if (phase !== "streaming" && parsed.length) list = parsed
    } catch (e) {}
    var result = []
    for (var i = 0; i < list.length; i++) {
      if (list[i].type === "md") result = result.concat(Attachments.markdownParts(list[i].text || ""))
      else result.push(list[i])
    }
    return result
  }

  property color foreground: Commons.Color.foreground
  property color accent: Commons.Color.accent
  property color urgent: Commons.Color.urgent
  property string fontFamily: Style.font.family

  readonly property bool fromUser: role === "user"
  readonly property color dim: Qt.darker(foreground, 1.4)
  readonly property var activityList: {
    try {
      var list = JSON.parse(activities)
      return Array.isArray(list) ? list : []
    } catch (e) {
      return []
    }
  }
  // The time sits outside the cards (S14.11): left of the user's card, right of the reply card.
  // The gutter is always reserved, sized for the widest label ("Oct 26, 2025"), so a message
  // keeps its width whether or not it has a time (no jump when it gets stamped).
  readonly property real timeGap: Style.space(6)
  readonly property real timeGutter: Math.ceil(widestTime.width) + timeGap
  readonly property real userMaxWidth: Math.max(0, Math.min(width * 0.85, width - timeGutter))
  readonly property real replyWidth: Math.max(0, width - timeGutter)
  readonly property bool footerShown: !fromUser && canCopy
  // The last rendered segment, when it is plain prose whose last line ends the reply.
  readonly property var lastProse: {
    var count = segmentRepeater.count
    var loader = count > 0 ? segmentRepeater.itemAt(count - 1) : null
    var item = loader ? loader.item : null
    return item && item.textItem !== undefined && !item.togglesVisible && item.textItem.visible ? item : null
  }
  readonly property rect lastLineRect: {
    if (!lastProse) return Qt.rect(0, 0, 0, 0)
    var edit = lastProse.textItem
    // Re-evaluate when the text, its layout or the width change.
    edit.contentHeight; edit.contentWidth; edit.width; edit.text
    return edit.positionToRectangle(edit.length)
  }
  readonly property real lastLineHeight: lastLineRect.height > 0 ? lastLineRect.height : footerRow.height
  readonly property bool footerInline: footerShown && lastProse !== null && footer === ""
    && lastLineRect.x + Style.space(12) + footerRow.implicitWidth <= assistantColumn.width
  readonly property bool footerOwnRow: footerShown && !footerInline
  readonly property string footer: {
    if (fromUser) return ""
    if (phase === "error") return error || "The answer failed."
    if (phase === "stopped") return "Stopped"
    if (phase === "streaming" && text === "" && activityList.length === 0) return "…"
    return ""
  }

  implicitHeight: fromUser ? userStack.implicitHeight : assistantStack.implicitHeight

  // The raw reply text over stdin (never argv); closing stdin lets wl-copy finish.
  function copyText() {
    if (clipboard.running || text === "") return
    clipboard.command = clipboardCommand
    clipboard.running = true
  }
  Process {
    id: clipboard
    stdinEnabled: true
    onStarted: { write(bubble.text); stdinEnabled = false }
    onExited: function(exitCode) {
      bubble.copyState = exitCode === 0 ? "copied" : "failed"
      stdinEnabled = true
      copyReset.restart()
    }
  }
  Timer { id: copyReset; interval: 1500; onTriggered: bubble.copyState = "idle" }

  // The copy icon and the time are hover-only chrome (S14.13): they fade (opacity only, so their
  // space stays reserved and nothing moves) while the pointer is over this message, for a short
  // grace after it leaves, while the copy reports its result, while keyboard focus is inside, or
  // after a tap toggled them. The hover target is the whole message: card, gutter time and action
  // lines; for the user's message, not the empty part of the row left of its time.
  readonly property real hoverLeft: {
    if (!fromUser) return 0
    var left = Math.min(userCard.visible ? userCard.x : width, userAttachments.visible ? userAttachments.x : width)
    return Math.max(0, userStack.x + left - timeGutter)
  }
  readonly property bool pointerOver: hoverWatch.hovered && hoverWatch.point.position.x >= hoverLeft
  property bool pointerNear: false
  property bool tapped: false
  // Focus on a keyboard-reachable control inside (Tab); a click into the read-only text, which
  // Tab never reaches, does not pin it.
  readonly property bool keyboardFocusInside: {
    var item = Window.activeFocusItem
    if (!item || !item.activeFocusOnTab) return false
    for (var p = item; p; p = p.parent) if (p === bubble) return true
    return false
  }
  readonly property bool chromeShown: pointerNear || tapped || copyState !== "idle" || keyboardFocusInside
  property real chromeOpacity: chromeShown ? 1 : 0
  Behavior on chromeOpacity { NumberAnimation { duration: bubble.chromeShown ? 120 : 200; easing.type: Easing.OutCubic } }
  onPointerOverChanged: {
    if (pointerOver) { hoverGrace.stop(); pointerNear = true }
    else hoverGrace.restart()
  }
  Timer { id: hoverGrace; interval: 250; onTriggered: bubble.pointerNear = false }
  // Above the content, so they see pointer events before the text does; both are passive, so
  // clicks, text selection and links still reach the card.
  Item {
    anchors.fill: parent
    z: 1
    HoverHandler { id: hoverWatch }
    TapHandler {
      acceptedDevices: PointerDevice.TouchScreen
      onTapped: function(eventPoint) {
        if (eventPoint.position.x < bubble.hoverLeft) return
        // A tap on the copy icon copies; it does not also toggle the chrome away.
        var onCopy = copyAction.mapFromItem(bubble, eventPoint.position.x, eventPoint.position.y)
        if (copyAction.visible && copyAction.contains(onCopy)) return
        bubble.tapped = !bubble.tapped
      }
    }
  }

  component TimeLabel: Text {
    objectName: "messageTime"
    visible: text !== ""
    opacity: bubble.chromeOpacity
    text: bubble.timeText
    color: Qt.rgba(bubble.foreground.r, bubble.foreground.g, bubble.foreground.b, 0.55)
    textFormat: Text.PlainText
    font.family: bubble.fontFamily
    font.pixelSize: Style.font.caption - 1
  }
  // An upper bound of every label: "Mmm" is at least as wide as any month abbreviation.
  TextMetrics {
    id: widestTime
    text: "Mmm 00, 0000"
    font.family: bubble.fontFamily
    font.pixelSize: Style.font.caption - 1
  }

  // A local image: a low-quality (240 px) preview that opens the viewer on click.
  component Thumbnail: Rectangle {
    id: thumb
    property string url: ""
    property string path: ""
    property string name: ""
    property string mime: ""
    property alias imageName: picture.objectName
    property alias hitName: hit.objectName
    readonly property bool failed: picture.status === Image.Error
    width: picture.status === Image.Ready ? picture.paintedWidth : Style.space(120)
    height: picture.status === Image.Ready ? picture.paintedHeight : Style.space(80)
    radius: Style.cornerRadius
    color: Qt.rgba(bubble.foreground.r, bubble.foreground.g, bubble.foreground.b, 0.06)
    clip: true
    Image {
      id: picture
      width: Math.min(240, bubble.width * 0.7)
      height: 180
      source: thumb.url
      sourceSize.width: 240
      fillMode: Image.PreserveAspectFit
      horizontalAlignment: Image.AlignLeft
      verticalAlignment: Image.AlignTop
      asynchronous: true
      cache: true
    }
    MouseArea {
      id: hit
      anchors.fill: parent
      cursorShape: Qt.PointingHandCursor
      onClicked: bubble.openImage({path: thumb.path, url: thumb.url, name: thumb.name, mime: thumb.mime})
    }
  }

  Column {
    id: userStack
    visible: bubble.fromUser
    width: bubble.width
    spacing: Style.space(3)

    Flow {
      id: userAttachments
      objectName: "userAttachments"
      visible: bubble.attachmentList.length > 0
      anchors.right: parent.right
      width: Math.min(bubble.userMaxWidth, implicitWidth)
      layoutDirection: Qt.RightToLeft
      spacing: Style.space(6)
      Repeater {
        model: bubble.fromUser ? bubble.attachmentList : []
        Loader {
          id: attachmentView
          required property var modelData
          readonly property bool previewable: !!modelData.path && Attachments.isImage(modelData.mime)
          // A file that is gone or unreadable falls back to its chip, never a broken image.
          property bool broken: false
          sourceComponent: previewable && !broken ? thumbnail : chip
          Component {
            id: thumbnail
            Thumbnail {
              objectName: "attachmentThumb"
              imageName: "attachmentThumbImage"
              hitName: "attachmentThumbHit"
              path: modelData.path
              url: Attachments.fileUrl(modelData.path)
              name: modelData.name
              mime: modelData.mime
              onFailedChanged: if (failed) attachmentView.broken = true
            }
          }
          Component {
            id: chip
            Row {
              spacing: Style.space(2)
              layoutDirection: Qt.RightToLeft
              // Files that are not fetched for a thumbnail open on demand: the local copy, or the
              // daemon's (S14.7) once the bridge has downloaded it.
              Ui.PanelActionButton {
                objectName: "attachmentOpen"
                visible: !Attachments.autoFetched(modelData.mime) && !modelData.loading
                  && (!!modelData.path || !!modelData.uploadId)
                anchors.verticalCenter: parent.verticalCenter
                iconText: "󰏌"
                tooltipText: "Open " + modelData.name
                foreground: bubble.dim
                fontFamily: "JetBrainsMono Nerd Font"
                fontSize: Style.font.caption + 2
                onClicked: bubble.openFile(modelData)
              }
              AttachmentChip {
                name: modelData.name
                size: modelData.size
                mime: modelData.mime
                path: modelData.path || ""
                // History without bytes we can fetch (old daemons, failed downloads) keeps the chip.
                note: modelData.loading ? (Attachments.isImage(modelData.mime) ? "loading preview…" : "downloading…")
                  : Attachments.isImage(modelData.mime) ? "preview unavailable" + (modelData.reason ? " · " + modelData.reason : "")
                  : (modelData.reason || "")
                foreground: bubble.foreground
                fontFamily: bubble.fontFamily
              }
            }
          }
        }
      }
    }

    Rectangle {
      id: userCard
      objectName: "userCard"
      visible: bubble.text !== ""
      anchors.right: parent.right
      width: Math.min(bubble.userMaxWidth, userText.implicitWidth + Style.space(20))
      height: userText.implicitHeight + Style.space(12)
      radius: Style.cornerRadius
      color: Qt.rgba(bubble.foreground.r, bubble.foreground.g, bubble.foreground.b, 0.08)

      TextEdit {
        id: userText
        objectName: "userText"
        anchors.fill: parent
        anchors.leftMargin: Style.space(10)
        anchors.rightMargin: Style.space(10)
        anchors.topMargin: Style.space(6)
        anchors.bottomMargin: Style.space(6)
        readOnly: true
        selectByMouse: true
        textFormat: TextEdit.PlainText
        wrapMode: TextEdit.Wrap
        text: bubble.fromUser ? bubble.text : ""
        color: bubble.foreground
        selectionColor: Style.selectionFillFor(bubble.foreground, bubble.accent)
        font.family: bubble.fontFamily
        font.pixelSize: Style.font.body
      }
    }
  }
  // Left of the card, bottom-aligned with its last text line; left of the attachments when
  // there is no text. Never adds a row.
  TimeLabel {
    readonly property Item target: userCard.visible ? userCard : userAttachments
    readonly property real inset: userCard.visible ? userText.anchors.bottomMargin : 0
    visible: bubble.fromUser && target.visible && text !== ""
    x: userStack.x + target.x - bubble.timeGap - width
    y: userStack.y + target.y + target.height - inset - height
  }

  Column {
    id: assistantStack
    visible: !bubble.fromUser
    width: bubble.width
    spacing: Style.space(8)
    ActivityGroup {
      objectName: "messageActivities"
      width: bubble.replyWidth
      visible: bubble.activityList.length > 0
      activities: bubble.activityList
    }
    Rectangle {
      id: assistantCard
      objectName: "assistantReply"
      visible: bubble.text !== "" || bubble.reasoning !== "" || bubble.footer !== ""
      // The column is not laid out while the card is hidden, so a reply that starts empty and
      // then streams in would keep a zero-height column and footer: lay them out again once shown.
      onVisibleChanged: if (visible) Qt.callLater(function() { assistantColumn.forceLayout(); footerRow.forceLayout() })
      width: bubble.replyWidth
      // Room for the footer below the text when it cannot share the last line.
      height: assistantColumn.implicitHeight + Style.space(20) + (bubble.footerOwnRow ? footerRow.height + Style.space(6) : 0)
      radius: Style.cornerRadius
      // Square on the rail side, like the action lines above it.
      topLeftRadius: 0
      bottomLeftRadius: 0
      color: bubble.assistantTint
      Rectangle {
        objectName: "assistantRail"
        width: 2
        height: parent.height
        color: bubble.rose
      }
      Column {
        id: assistantColumn
        x: Style.space(10); y: Style.space(10)
        width: parent.width - Style.space(20)
        spacing: Style.space(6)
        Collapsible {
          width: parent.width
          visible: bubble.reasoning !== ""
          text: bubble.reasoning
          label: "Thinking…"
        }
        Repeater {
          id: segmentRepeater
          model: bubble.fromUser ? [] : bubble.renderedSegments
          Loader {
            required property var modelData
            width: assistantColumn.width
            sourceComponent: modelData.type === "code" ? codeSegment : (modelData.type === "image" ? imageSegment : proseSegment)
            Component {
              id: codeSegment
              CodeBlock {
                width: parent.width
                code: modelData.code
                lang: modelData.lang || ""
                html: modelData.html || ""
              }
            }
            Component {
              id: proseSegment
              Collapsible {
                objectName: "proseText"
                width: parent.width
                text: modelData.text || ""
                markdown: true
              }
            }
            Component {
              id: imageSegment
              Thumbnail {
                imageName: "markdownImage"
                url: modelData.url
                path: Attachments.localPathOf(modelData.url)
                name: modelData.alt || ""
              }
            }
          }
        }
        Text {
          visible: bubble.footer !== ""
          width: parent.width
          text: bubble.footer
          color: bubble.phase === "error" ? bubble.urgent : bubble.dim
          wrapMode: Text.Wrap
          textFormat: Text.PlainText
          font.family: bubble.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
      // Footer: the copy icon, on the last text line when it fits there, else on its own row (the
      // spacer above). Bind to the conditions, not to the children's effective visibility.
      Row {
        id: footerRow
        visible: bubble.footerShown
        spacing: Style.space(6)
        anchors.right: assistantColumn.right
        y: bubble.footerInline
          ? assistantColumn.y + assistantColumn.implicitHeight - bubble.lastLineHeight / 2 - height / 2
          : assistantColumn.y + assistantColumn.implicitHeight + Style.space(6)
        Ui.PanelActionButton {
          id: copyAction
          objectName: "replyCopy"
          anchors.verticalCenter: parent.verticalCenter
          visible: bubble.canCopy
          opacity: bubble.chromeOpacity
          // Not clickable (and no tooltip) while hidden.
          enabled: bubble.chromeOpacity > 0
          iconText: bubble.copyState === "copied" ? "󰄬" : "󰆏"
          tooltipText: bubble.copyState === "copied" ? "Copied" : (bubble.copyState === "failed" ? "Copy failed" : "Copy reply")
          foreground: bubble.copyState === "failed" ? bubble.urgent : bubble.dim
          fontFamily: "JetBrainsMono Nerd Font"
          fontSize: Style.font.caption + 2
          onClicked: bubble.copyText()
        }
      }
    }
  }
  // Right of the card, bottom-aligned with its last line (the text's, or the copy row's).
  TimeLabel {
    visible: !bubble.fromUser && assistantCard.visible && text !== ""
    x: assistantStack.x + assistantCard.x + assistantCard.width + bubble.timeGap
    y: assistantStack.y + assistantCard.y + assistantCard.height - assistantColumn.y - height
  }
}
