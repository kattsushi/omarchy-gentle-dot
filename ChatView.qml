import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Commons as Commons

// The conversation list. Follows new content while the user is at the bottom;
// scrolling up pins the view until the user scrolls back down.
ListView {
  id: view

  property color foreground: Commons.Color.foreground
  property color accent: Commons.Color.accent
  property color urgent: Commons.Color.urgent
  property string fontFamily: Style.font.family
  property bool followEnd: true
  property var client: null
  readonly property bool hasAsks: client !== null && client.pendingAsks.length > 0
  readonly property Item askFocusTarget: footerItem ? footerItem.firstFocusTarget : null

  function focusAsk(requestId) {
    var cards = footerItem ? footerItem.cards : null
    if (!cards) return
    for (var i = 0; i < cards.count; i++) {
      var card = cards.itemAt(i)
      if (card.ask.requestId === requestId && card.focusTarget) {
        // The footer can be taller than the viewport. Reveal this card rather
        // than the very end (which would hide its first control).
        followEnd = false
        contentY = Math.max(originY, Math.min(originY + contentHeight - height,
          footerItem.y + card.y))
        card.focusTarget.forceActiveFocus()
        return
      }
    }
  }

  function scrollToEnd() {
    followEnd = true
    Qt.callLater(view.positionViewAtEnd)
  }

  clip: true
  spacing: Style.space(12)
  boundsBehavior: Flickable.StopAtBounds
  // Mouse drags select text in the bubbles; the wheel and the scroll bar scroll.
  acceptedButtons: Qt.NoButton
  ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

  onMovementEnded: followEnd = atYEnd
  onFlickEnded: followEnd = atYEnd
  onContentHeightChanged: if (followEnd) Qt.callLater(view.positionViewAtEnd)
  onCountChanged: if (followEnd) Qt.callLater(view.positionViewAtEnd)
  onHeightChanged: if (followEnd) Qt.callLater(view.positionViewAtEnd)

  footer: Column {
    property alias cards: askCards
    readonly property Item firstFocusTarget: askCards.count > 0 && askCards.itemAt(0) ? askCards.itemAt(0).focusTarget : null
    width: view.width
    spacing: Style.space(12)
    Repeater {
      id: askCards
      model: view.client ? view.client.askCards : null
      AskCard {
        required property string askJson
        width: view.width
        ask: JSON.parse(askJson)
        client: view.client
        foreground: view.foreground
        urgent: view.urgent
        fontFamily: view.fontFamily
      }
    }
  }

  delegate: MessageBubble {
    required property var model
    segments: model.segments
    reasoning: model.reasoning
    at: model.at
    attachments: model.attachments
    onOpenImage: function(image) { if (view.client) view.client.openImage(image) }
    onOpenFile: function(file) { if (view.client) view.client.openAttachment(file) }
    now: view.client ? view.client.now : Date.now()
    width: ListView.view.width
    foreground: view.foreground
    accent: view.accent
    urgent: view.urgent
    fontFamily: view.fontFamily
  }
}
