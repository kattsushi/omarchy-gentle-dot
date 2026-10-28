import QtQuick
import Quickshell
import Quickshell.Io
import "bridge/time-format.mjs" as TimeFormat
import "bridge/attachments.mjs" as Attachments
import "privacy.mjs" as Privacy
import "avatar/mood.mjs" as Mood
import "status.mjs" as Status

// The plugin's shared service: one connection to the Gentle Dot daemon and its
// conversation for every bar widget instance (the bar makes one per monitor).
// The daemon WebSocket is relayed by bridge/bridge.mjs as newline-delimited JSON
// over stdio (contract at the top of that file). Widgets look this object up with
// bar.shell.serviceFor("omarchy-gentle-dot") and push their settings through
// configure(); the bridge starts once the first settings arrive.
Item {
  id: client

  readonly property string pluginId: "omarchy-gentle-dot"
  readonly property string localUrl: "ws://127.0.0.1:4317/ws"
  readonly property string localTokenFile: "~/.gentle-dot/token"
  readonly property string remotesDir: "~/.config/gentle-dot/remotes"

  // Capability-scoped shell facade injected by the host; its updateEntryInline()
  // writes this plugin's own bar entry in shell.json.
  property var shell: null
  // The bar entry's inline settings, as the widgets last pushed them.
  property var entrySettings: ({})

  // Which view the panels show: "chat" or "settings".
  property string view: "chat"
  property string settingsSection: ""
  property string draft: ""
  readonly property bool notificationsEnabled: entrySettings.notifications !== false
  readonly property bool notificationSoundEnabled: entrySettings.notificationSound !== false
  property Notifier notifier: Notifier { client: client }
  property var visiblePanels: []
  readonly property bool panelVisible: visiblePanels.length > 0

  function reportPanelVisibility(owner, visible) {
    var next = visiblePanels.filter(function(item) { return item !== owner })
    if (visible) next.push(owner)
    visiblePanels = next
  }

  function saveNotifications(value) {
    var next = Object.assign({}, entrySettings)
    next.notifications = !!value
    return saveSettings(next)
  }

  function saveNotificationSound(value) {
    var next = Object.assign({}, entrySettings)
    next.notificationSound = !!value
    return saveSettings(next)
  }

  // Background opacity of the popup, pinned panel and detached window (like ghostty's
  // background-opacity); text and bubbles stay opaque. Kept between 0.5 and 1.
  readonly property real defaultPanelOpacity: 0.95
  readonly property real panelOpacity: clampOpacity(entrySettings.panelOpacity)

  function clampOpacity(value) {
    var number = typeof value === "number" ? value : (typeof value === "string" && value.trim() ? Number(value) : NaN)
    return isFinite(number) ? Math.min(1, Math.max(0.5, number)) : defaultPanelOpacity
  }

  function savePanelOpacity(value) {
    var next = Object.assign({}, entrySettings)
    next.panelOpacity = clampOpacity(value)
    return saveSettings(next)
  }

  // --- attachments ------------------------------------------------------------

  // Files waiting in the composer, shared by every surface like the draft:
  // [{path, name, size, mime}]. Immutable updates notify every panel.
  property var attachments: []
  property bool uploading: false
  property string uploadRequestId: ""
  property string uploadStatus: ""
  property string inspectRequestId: ""
  // This session's uploads: "uploadId/name" -> local path, and "name|size" -> local path to
  // match the AttachmentInfo of daemons that send no upload id.
  property var localFiles: ({})
  property var localByInfo: ({})
  // Files from history or other clients that a patched daemon (S14.7) serves: the bridge downloads
  // them into its private cache. "uploadId/name" -> {state: "loading" | "ready" | "failed", path,
  // code}. Images (png, jpeg, gif, webp) are fetched for their thumbnail; other files only on Open.
  property var remoteFiles: ({})
  // requestId -> "uploadId/name", and the keys the user asked to open once they are cached.
  property var fetchRequests: ({})
  property var pendingOpens: ({})
  // Opens a file with its default application; injectable for headless tests.
  property var openCommand: ["xdg-open"]
  // The image shown in the viewer: {path, url, name, mime}, or null.
  property var viewerImage: null
  // Injectable commands keep headless tests off the real Wayland clipboard.
  property var clipboardListCommand: ["wl-paste", "--list-types"]
  property var clipboardPasteCommand: ["wl-paste"]
  property var imageCopyCommand: ["wl-copy"]
  readonly property string pasteDir: (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/omarchy-gentle-dot"

  readonly property string notLocalNotice: "Only files from this computer can be attached. Save it first, then drop the file."

  // Paths or file:// URLs; the bridge reports their size and type, then the limits apply.
  // Anything else (https, data: …) is never downloaded: the notice says why it was left out.
  function addAttachmentPaths(values) {
    var paths = []
    var notLocal = 0
    for (var i = 0; i < (values || []).length; i++) {
      var value = String(values[i] || "")
      if (!value) continue
      var path = Attachments.localPathOf(value)
      if (!path) notLocal++
      else if (paths.indexOf(path) < 0) paths.push(path)
    }
    if (notLocal) showNotice(notLocalNotice, "warning")
    if (!paths.length) return false
    requestSerial++
    inspectRequestId = "inspect-" + requestSerial
    if (send({ type: "inspect_files", requestId: inspectRequestId, paths: paths })) return true
    showNotice("The bridge is not running: files cannot be attached.", "error")
    return false
  }

  // A drop on the panel: URLs when it carries any (local files attach), otherwise its text
  // becomes a .txt attachment. Whitespace-only text is ignored.
  function dropItems(urls, text) {
    if (urls && urls.length) return addAttachmentPaths(urls)
    var body = String(text || "")
    if (!body.trim() || textSaver.running) return false
    textSaver.path = pasteDir + "/dropped-text-" + Date.now() + ".txt"
    textSaver.text = body
    // The path is an argument and the text goes over stdin, never into the script.
    textSaver.command = ["sh", "-c",
      "umask 077; mkdir -p -- \"$1\" && chmod 700 -- \"$1\" && cat > \"$2\" && chmod 600 -- \"$2\"",
      "sh", pasteDir, textSaver.path]
    textSaver.stdinEnabled = true
    textSaver.running = true
    return true
  }

  function acceptInspected(files) {
    var result = Attachments.addWithinLimits(attachments, files, Attachments.ATTACHMENT_LIMITS)
    attachments = result.list
    if (result.errors.length) showNotice(result.errors.join(" "), "error")
  }

  function removeAttachment(path) {
    if (uploading) return
    attachments = attachments.filter(function(file) { return file.path !== path })
  }

  // AttachmentInfo list -> JSON for a message row: the local path when this client sent the file or
  // its cached copy is ready; otherwise `uploadId` (Open fetches it), `loading` or the failure `reason`.
  // Images with an upload id are fetched here, once per session.
  function attachmentsJson(list) {
    var rows = []
    for (var i = 0; Array.isArray(list) && i < list.length; i++) {
      var info = list[i] || {}
      var row = { name: String(info.name || "file"), size: Number(info.size) || 0, mime: String(info.mime || "") }
      var id = Attachments.validUploadId(info.uploadId) && Attachments.validStoredName(row.name) ? info.uploadId : ""
      if (id) row.uploadId = id
      var remote = id ? remoteFiles[id + "/" + row.name] : null
      var path = (id && localFiles[id + "/" + row.name]) || localByInfo[row.name + "|" + row.size]
        || (remote && remote.state === "ready" ? remote.path : "")
      if (path) row.path = path
      else if (id) {
        if (!remote && Attachments.autoFetched(row.mime)) remote = fetchAttachment(id, row.name, false)
        if (remote && remote.state === "loading") row.loading = true
        if (remote && remote.state === "failed") row.reason = fetchReason(remote.code)
      }
      rows.push(row)
    }
    return JSON.stringify(rows)
  }

  function fetchReason(code) {
    return ({ unauthorized: "token rejected", not_found: "not found", too_large: "too large",
      unsupported: "not supported" })[code] || "download failed"
  }

  function setRemoteFile(key, entry) {
    var next = Object.assign({}, remoteFiles)
    if (entry) next[key] = entry
    else delete next[key]
    remoteFiles = next
  }

  // Asks the bridge for a stored file; `open` opens it once cached. Returns its entry, or null when
  // the bridge is not running. A cached file is reused, one in flight is not asked for twice.
  function fetchAttachment(uploadId, name, open) {
    var key = uploadId + "/" + name
    var known = remoteFiles[key]
    if (known && known.state === "ready") {
      if (open) openFile(known.path)
      return known
    }
    if (open) pendingOpens[key] = true
    if (known && (known.state === "loading" || !open)) return known
    requestSerial++
    var requestId = "fetch-" + requestSerial
    if (!send({ type: "fetch_attachment", requestId: requestId, uploadId: uploadId, name: name })) {
      delete pendingOpens[key]
      return null
    }
    fetchRequests[requestId] = key
    var entry = { state: "loading" }
    setRemoteFile(key, entry)
    return entry
  }

  // Rebuilds the attachment rows that show this file, after its fetch finished.
  function refreshAttachmentRows(key) {
    for (var i = 0; i < messages.count; i++) {
      var rows = []
      try { rows = JSON.parse(messages.get(i).attachments) } catch (e) { rows = [] }
      if (rows.some(function(row) { return row.uploadId + "/" + row.name === key }))
        messages.setProperty(i, "attachments", attachmentsJson(rows))
    }
  }

  function fetchFinished(msg, entry) {
    var key = fetchRequests[msg.requestId]
    if (!key) return
    delete fetchRequests[msg.requestId]
    setRemoteFile(key, entry)
    refreshAttachmentRows(key)
    if (!pendingOpens[key]) return
    delete pendingOpens[key]
    if (entry.state === "ready") openFile(entry.path)
    else showNotice("Could not open " + key.slice(key.indexOf("/") + 1) + ": " + fetchReason(entry.code) + ".", "error")
  }

  // A chip's Open: its local file, or the stored copy once the bridge has it.
  function openAttachment(file) {
    if (!file) return false
    if (file.path) return openFile(file.path)
    if (!file.uploadId) return false
    if (fetchAttachment(file.uploadId, file.name, true)) return true
    showNotice("The bridge is not running: the file cannot be opened.", "error")
    return false
  }

  function openFile(path) {
    if (!path) return false
    Quickshell.execDetached(openCommand.concat([String(path)]))
    return true
  }

  // Fetches that will never answer (the bridge stopped) or failed on the network are asked again
  // when the next history arrives.
  function forgetFetches(states, codes) {
    var next = ({})
    for (var key in remoteFiles) {
      var entry = remoteFiles[key]
      if (states.indexOf(entry.state) < 0 && codes.indexOf(entry.code) < 0) next[key] = entry
    }
    remoteFiles = next
    if (states.indexOf("loading") >= 0) {
      fetchRequests = ({})
      pendingOpens = ({})
    }
  }

  function rememberUploads(files) {
    var byId = Object.assign({}, localFiles)
    var byInfo = Object.assign({}, localByInfo)
    for (var i = 0; i < (files || []).length; i++) {
      var file = files[i]
      if (!file || !file.path) continue
      byId[file.uploadId + "/" + file.name] = file.path
      byInfo[file.name + "|" + file.size] = file.path
    }
    localFiles = byId
    localByInfo = byInfo
  }

  function openImage(image) {
    if (!image || (!image.path && !image.url)) return
    viewerImage = { path: String(image.path || ""), url: String(image.url || Attachments.fileUrl(image.path)),
      name: String(image.name || ""), mime: String(image.mime || "") }
  }

  function closeImage() { viewerImage = null }

  // Copies the viewer's local image with its type (wl-copy --type <mime> < file).
  function copyImage(done) {
    var image = viewerImage
    if (!image || !image.path || imageCopier.running) { if (done) done(false); return }
    imageCopier.done = done || null
    imageCopier.command = ["sh", "-c", "f=$1; shift; exec \"$@\" < \"$f\"", "sh", image.path]
      .concat(imageCopyCommand, ["--type", image.mime || "image/png"])
    imageCopier.running = true
  }

  function attachViewerImage() {
    var image = viewerImage
    if (!image || !image.path) return false
    closeImage()
    return addAttachmentPaths([image.path])
  }

  // Ctrl+V: a clipboard image becomes a private temp file attachment; anything else is
  // left to the text field (pasteText).
  function pasteClipboard(pasteText) {
    if (clipboardTypes.running || clipboardSaver.running) return
    clipboardTypes.fallback = pasteText || null
    clipboardTypes.command = clipboardListCommand
    clipboardTypes.running = true
  }

  function clipboardTypesListed(exitCode, text) {
    var fallback = clipboardTypes.fallback
    clipboardTypes.fallback = null
    var types = exitCode === 0 ? String(text || "").split("\n").map(function(type) { return type.trim() }) : []
    var preferred = ["image/png", "image/jpeg", "image/webp", "image/gif"]
    var type = preferred.find(function(candidate) { return types.indexOf(candidate) >= 0 })
    if (!type) { if (fallback) fallback(); return }
    var extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[type]
    clipboardSaver.path = pasteDir + "/pasted-" + Date.now() + "." + extension
    clipboardSaver.command = ["sh", "-c",
      "umask 077; mkdir -p -- \"$1\" && chmod 700 -- \"$1\" && f=$2 && t=$3 && shift 3 && \"$@\" --type \"$t\" > \"$f\"",
      "sh", pasteDir, clipboardSaver.path, type].concat(clipboardPasteCommand)
    clipboardSaver.running = true
  }

  // One clock for every message timestamp, refreshed once a minute.
  property real now: Date.now()
  readonly property int clockInterval: 60000

  function openChat() {
    view = "chat"
    if (detached && detachedOwner) detachedOwner.showDetached()
    else if (shell && typeof shell.summon === "function") shell.summon(pluginId, "{}")
  }
  readonly property bool voiceSendOnStop: entrySettings.voiceSendOnStop === true
  property Voice voice: Voice {
    client: client
    onTranscriptReady: function(text, sendNow) { client.acceptVoiceTranscript(text, sendNow) }
    onStateChanged: client.noteActivity()
  }

  function acceptVoiceTranscript(text, sendNow) {
    var transcript = String(text || "").trim()
    if (!transcript) return
    if (sendNow && sendText(transcript)) return
    draft = draft + (draft && !/\s$/.test(draft) ? " " : "") + transcript
    if (sendNow) showNotice("Not connected: transcript kept in the draft.", "warning")
  }

  function saveVoiceSendOnStop(value) {
    var next = Object.assign({}, entrySettings)
    next.voiceSendOnStop = !!value
    return saveSettings(next)
  }
  // Session-only UI preference, shared across monitors; never saved to settings.
  property bool panelPinned: false
  property bool detached: false
  // One owning widget even with a bar on every monitor. The service and bridge
  // outlive this window; docking/xdg-close only change UI state.
  property var detachedOwner: null

  function setPinned(value) {
    panelPinned = !!value && !detached
  }

  function setDetached(value, owner) {
    if (value) {
      setPinned(false)
      if (!detachedOwner && owner) detachedOwner = owner
      detached = true
      if (detachedOwner) detachedOwner.showDetached()
      else if (shell && typeof shell.summon === "function") shell.summon(pluginId, "{}")
    } else {
      detached = false
      detachedOwner = null
    }
  }

  // --- avatar sleep -------------------------------------------------------------

  // The avatar falls asleep after avatarSleepMinutes without activity (0 = never). Activity is
  // tracked here, in the shared service, so time with the panel hidden counts too, and sleep is
  // decided from timestamps: a check once a minute and whenever an avatar is shown, never per
  // frame. Activity: the draft changing (typing, dictation), the pointer over the panel, clicks,
  // sending, voice, and chat traffic (messages, activities, asks, notices, agent state and
  // connection changes).
  readonly property int avatarSleepMinutes: Mood.sleepMinutes(entrySettings.avatarSleepMinutes)
  property real lastActivity: Date.now()
  property bool asleep: false
  // Added to Date.now(): tests fake the clock with it.
  property real clockOffset: 0
  property int sleepCheckInterval: 60000
  // Something in progress keeps the avatar awake however old the last event is.
  readonly property bool engaged: pendingAsks.length > 0 || uploading || voice.state !== "idle"
    || (connected && agentState !== "" && agentState !== "idle")
  readonly property var activityTypes: ["ready", "ask", "ask_resolved", "agent_state", "user_message", "message_delta",
    "reasoning_delta", "message_done", "activity", "upload_progress", "upload_done", "upload_error", "toast", "error"]

  function nowMs() { return Date.now() + clockOffset }

  function noteActivity() {
    lastActivity = nowMs()
    asleep = false
  }

  function checkSleep() {
    asleep = Mood.sleepDue({ now: nowMs(), lastActivity: lastActivity, minutes: avatarSleepMinutes, engaged: engaged })
    return asleep
  }

  // Test-only (IPC avatarSleep): asleep now, as if the time had passed; false wakes it up.
  function forceSleep(value) {
    if (!value) return noteActivity()
    lastActivity = nowMs() - Math.max(1, avatarSleepMinutes) * 60000
    asleep = true
  }

  onAvatarSleepMinutesChanged: checkSleep()
  onDraftChanged: noteActivity()

  function saveAvatarSleepMinutes(value) {
    var next = Object.assign({}, entrySettings)
    next.avatarSleepMinutes = Mood.sleepMinutes(value)
    return saveSettings(next)
  }

  property Tailnet tailnet: Tailnet {}

  readonly property bool remote: configured && serverUrl !== localUrl
  readonly property string host: hostOf(serverUrl)

  // --- privacy ------------------------------------------------------------------

  // Screen-sharing mask for connection details (hosts, IPs, URLs, tailnet names, token paths)
  // in Settings and the header. Session-only and never saved: hidden on shell start, whenever
  // the first panel opens and when the last one closes (popup, pinned panel, detached window).
  property bool privacyMasked: true
  property var openPanels: []
  // Names no pattern recognises (a tailnet device name has no dots), masked wherever they appear.
  readonly property var sensitiveTerms: {
    var terms = [host]
    if (tokenFile !== localTokenFile) terms.push(tokenFile)
    for (var i = 0; i < tailnet.peers.length; i++) {
      var peer = tailnet.peers[i] || {}
      terms.push(peer.hostName, peer.dnsName, peer.ip)
    }
    return terms
  }
  readonly property string headerTitle: "Gentle Dot" + (remote ? " · " + (privacyMasked ? "remote" : host) : "")
  // The eye toggle in the header and in Settings: 󰈉 while hidden, 󰈈 while shown.
  readonly property string privacyIcon: privacyMasked ? "󰈉" : "󰈈"
  readonly property string privacyTooltip: privacyMasked
    ? "Show hosts, addresses and URLs (hidden for screen sharing)"
    : "Hide hosts, addresses and URLs (hidden again when the panel closes)"

  function setPrivacyMasked(value) { privacyMasked = !!value }

  function reportPanelOpen(owner, open) {
    var wasOpen = openPanels.length > 0
    var next = openPanels.filter(function(item) { return item !== owner })
    if (open) next.push(owner)
    openPanels = next
    if (wasOpen !== next.length > 0) privacyMasked = true
  }

  // What the panels show: the value itself, or its masked form while privacyMasked.
  function displayText(value) { return privacyMasked ? Privacy.maskText(value, sensitiveTerms) : String(value || "") }
  function displayUrl(value) { return privacyMasked ? Privacy.maskUrl(value) : String(value || "") }
  function displayValue(value) { return privacyMasked ? Privacy.maskValue(value) : String(value || "") }

  property string nodePath: ""
  property string serverUrl: ""
  property string tokenFile: ""
  property bool configured: false

  // connecting | open | reconnecting | fatal | stopped
  property string connection: "stopped"
  property bool ready: false
  property string fatalReason: ""
  property string fatalMessage: ""
  property string agentState: ""
  property string model: ""

  readonly property bool connected: connection === "open" && ready
  readonly property bool busy: connected && (agentState === "thinking" || agentState === "working")

  // --- status label -------------------------------------------------------------

  // What the composer's label says the assistant is doing (status.mjs). Tracked for the current
  // turn only: tool calls still running (in order), the last ODD phase announced through
  // gentle_odd_phase, and whether reply text is arriving. Activities land on an assistant message
  // that may already be done, and a turn has several messages, so the turn ends with the agent
  // state (idle or error) or the connection, not with message_done.
  property var runningActivities: []
  property string oddPhase: ""
  property bool answering: false
  readonly property var status: Status.label({
    connection: connection, ready: ready, agentState: agentState, asks: pendingAsks.length,
    voice: voice.state, uploading: uploading, streaming: answering, phase: oddPhase,
    activity: runningActivities.length ? runningActivities[runningActivities.length - 1] : null
  })
  readonly property string statusLabel: status.text
  // accent | urgent | dim
  readonly property string statusTone: status.tone

  function trackActivity(activity) {
    if (!activity || !activity.id) return
    var phase = Status.phaseOf(activity)
    if (phase) oddPhase = phase === "clear" ? "" : phase
    var next = runningActivities.filter(function(item) { return item.id !== activity.id })
    if (activity.status === "running" && !phase) next.push(activity)
    runningActivities = next
  }

  function endTurn() {
    runningActivities = []
    oddPhase = ""
    answering = false
  }
  readonly property string bridgePath: decodeURIComponent(
    String(Qt.resolvedUrl("bridge/bridge.mjs")).replace(/^file:\/\//, "").replace(/[?#].*$/, ""))

  // The conversation. Roles: msgId, role ("user" | "assistant"), text,
  // phase ("streaming" | "done" | "stopped" | "error"), error, activities (JSON
  // array of {id, kind, title, status}, kept as text so the role stays flat).
  property ListModel messages: ListModel {}
  property var indexById: ({})

  // Immutable array updates notify every monitor's panel. Deadlines are local;
  // only the daemon resolves a request (expiry never sends an answer).
  property var pendingAsks: []
  // Stable delegates preserve drafts/focus when a different ask is resolved.
  property ListModel askCards: ListModel {}
  property var askDeadlines: ({})
  signal askArrived(string requestId)

  function removeAsk(requestId) {
    var at = pendingAsks.findIndex(function(ask) { return ask.requestId === requestId })
    if (at >= 0) askCards.remove(at)
    pendingAsks = pendingAsks.filter(function(ask) { return ask.requestId !== requestId })
    var deadlines = Object.assign({}, askDeadlines)
    delete deadlines[requestId]
    askDeadlines = deadlines
  }

  function clearAsks() {
    askCards.clear()
    pendingAsks = []
    askDeadlines = ({})
  }

  function receiveAsk(ask) {
    if (!ask || typeof ask.requestId !== "string" || !ask.requestId) return
    var list = pendingAsks.slice()
    var at = list.findIndex(function(item) { return item.requestId === ask.requestId })
    if (at < 0) {
      list.push(ask)
      askCards.append({askJson: JSON.stringify(ask)})
    } else {
      list[at] = ask
      askCards.setProperty(at, "askJson", JSON.stringify(ask))
    }
    var deadlines = Object.assign({}, askDeadlines)
    delete deadlines[ask.requestId]
    if (typeof ask.timeoutMs === "number" && ask.timeoutMs > 0)
      deadlines[ask.requestId] = Date.now() + ask.timeoutMs
    askDeadlines = deadlines
    pendingAsks = list
    if (at < 0) notifier.newAsk(ask)
    askArrived(ask.requestId)
  }

  function expireAsks() {
    var now = Date.now()
    for (var id in askDeadlines) if (askDeadlines[id] <= now) removeAsk(id)
  }

  // Shared UI/IPC answer path. Construct exactly one method-specific field;
  // app/PIN approvals deliberately have no ui_response path here.
  function answer(requestId, payload) {
    expireAsks()
    var ask = pendingAsks.find(function(item) { return item.requestId === requestId })
    if (!ask) return "ask_not_found"
    if (ask.method === "app" || ask.method === "pin") return "app_required"
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "bad_payload"
    var keys = Object.keys(payload)
    if (keys.length !== 1) return "bad_payload"
    var response = { type: "ui_response", requestId: requestId }
    if (payload.cancelled === true) response.cancelled = true
    else if (ask.method === "confirm" && typeof payload.confirmed === "boolean") response.confirmed = payload.confirmed
    else if ((ask.method === "input" || ask.method === "editor" || ask.method === "select")
      && typeof payload.value === "string" && payload.value.length <= 100000) {
      if (ask.method === "select" && (!Array.isArray(ask.options) || ask.options.indexOf(payload.value) < 0)) return "bad_payload"
      response.value = payload.value
    } else return "bad_payload"
    if (!connected) return "not_connected"
    return send(response) ? "sent" : "not_connected"
  }

  // Last toast or daemon error, cleared after a few seconds.
  property string notice: ""
  property string noticeLevel: "info"

  // Every line from the bridge: daemon messages unchanged plus the bridge's own
  // {"type":"bridge"} and {"type":"bridge_error"} lines.
  signal message(var msg)

  property bool restartPending: false
  property bool stopping: false
  property int requestSerial: 0

  function configure(settings) {
    var next = settings || {}
    var copy = ({})
    for (var key in next) copy[key] = next[key]
    entrySettings = copy
    var nextNode = String(next.nodePath || "node")
    var nextUrl = String(next.serverUrl || localUrl)
    var nextToken = String(next.tokenFile || localTokenFile)
    if (configured && nextNode === nodePath && nextUrl === serverUrl && nextToken === tokenFile) return
    // Another daemon means another conversation; its history arrives on ready.
    if (configured && nextUrl !== serverUrl) {
      resetMessages([])
      remoteFiles = ({})
      fetchRequests = ({})
      pendingOpens = ({})
    }
    nodePath = nextNode
    serverUrl = nextUrl
    tokenFile = nextToken
    configured = true
    settingsDebounce.restart()
  }

  function hostOf(url) {
    var match = String(url || "").match(/^wss?:\/\/(\[[^\]]*\]|[^\/:?#]+)/)
    return match ? match[1] : ""
  }

  function expandHome(path) {
    var text = String(path || "")
    var home = Quickshell.env("HOME") || ""
    return text === "~" || text.indexOf("~/") === 0 ? home + text.slice(1) : text
  }

  // Where the token of the remote daemon on this host is kept.
  function remoteTokenFile(hostName) {
    var slug = String(hostName || "").toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "")
    return remotesDir + "/" + (slug || "remote") + ".token"
  }

  // --- settings -------------------------------------------------------------

  // Writes a pasted token to `path` (0600, parent dir 0700). The token goes over
  // stdin, never argv; the path is an argument, never interpolated into the script.
  function writeToken(path, token, done) {
    var secret = String(token || "").trim()
    if (tokenWriter.running || !secret || /[\r\n]/.test(secret)) {
      if (done) done(false)
      return
    }
    tokenWriter.secret = secret
    tokenWriter.done = done || null
    tokenWriter.command = ["sh", "-c",
      "umask 077; d=$(dirname -- \"$1\"); mkdir -p -- \"$d\" && chmod 700 -- \"$d\""
        + " && IFS= read -r t && printf '%s\\n' \"$t\" > \"$1.tmp\" && chmod 600 -- \"$1.tmp\" && mv -f -- \"$1.tmp\" \"$1\"",
      "sh", expandHome(path)]
    tokenWriter.running = true
  }

  // Calls done(true) when `path` is a non-empty file.
  function tokenFileExists(path, done) {
    if (tokenProbe.running) {
      if (done) done(false)
      return
    }
    tokenProbe.done = done || null
    tokenProbe.command = ["test", "-s", expandHome(path)]
    tokenProbe.running = true
  }

  // Persists the connection in this plugin's bar entry, then restarts the bridge
  // with it. Local drops both keys so the entry falls back to the manifest defaults.
  function saveConnection(url, tokenPath) {
    if (!shell || typeof shell.updateEntryInline !== "function") return false
    var next = ({})
    for (var key in entrySettings) next[key] = entrySettings[key]
    if (url === localUrl && tokenPath === localTokenFile) {
      delete next.serverUrl
      delete next.tokenFile
    } else {
      next.serverUrl = url
      next.tokenFile = tokenPath
    }
    return saveSettings(next)
  }

  // One persistence path for connection and voice settings, preserving all keys.
  function saveSettings(next) {
    if (!shell || typeof shell.updateEntryInline !== "function") return false
    // updateEntryInline() answers false when nothing changed, which is fine.
    var unchanged = JSON.stringify(next) === JSON.stringify(entrySettings)
    if (!shell.updateEntryInline(pluginId, next) && !unchanged) return false
    configure(next)
    return true
  }

  // --- test connection --------------------------------------------------------

  // idle | testing | ok | failed
  property string testState: "idle"
  property string testMessage: ""

  // Runs a second, throwaway bridge against a candidate daemon; the live
  // connection is left alone. It is stopped on the first answer or after 6 s.
  function testConnection(url, tokenPath) {
    // One test at a time; a finished test's bridge is gone within moments.
    if (tester.running) return false
    testState = "testing"
    testMessage = "Testing " + url + "…"
    tester.command = [nodePath || "node", bridgePath, "--url", String(url || ""), "--token-file", String(tokenPath || "")]
    tester.running = true
    testTimer.restart()
    return true
  }

  function finishTest(ok, text) {
    if (testState !== "testing") return
    testState = ok ? "ok" : "failed"
    testMessage = text
    testTimer.stop()
    tester.running = false
  }

  function stopTest() {
    testTimer.stop()
    if (tester.running) tester.running = false
    testState = "idle"
    testMessage = ""
  }

  function handleTestLine(line) {
    var msg
    try {
      msg = JSON.parse(line)
    } catch (e) {
      return
    }
    if (!msg || typeof msg !== "object") return
    if (msg.type === "ready") {
      finishTest(true, "Connected (model: " + String(msg.model || "unknown") + ")")
    } else if (msg.type === "bridge" && msg.state === "reconnecting") {
      finishTest(false, "Unreachable")
    } else if (msg.type === "bridge" && msg.state === "fatal") {
      if (msg.reason === "unauthorized") finishTest(false, "Token rejected")
      else if (msg.reason === "bad_protocol") finishTest(false, "The daemon does not speak protocol v1")
      else if (msg.reason === "token_missing") finishTest(false, "No token saved for this daemon yet: paste it first")
      else finishTest(false, String(msg.message || msg.reason || "The test failed"))
    }
  }

  // --- connection -------------------------------------------------------------

  function send(obj) {
    if (!bridge.running) return false
    bridge.write(JSON.stringify(obj) + "\n")
    return true
  }

  function sendText(text) {
    noteActivity()
    var body = String(text || "").trim()
    if (!body || !connected) return false
    requestSerial++
    var requestId = "omarchy-" + Date.now().toString(36) + "-" + requestSerial + "-" + Math.random().toString(36).slice(2, 8)
    return send({ type: "send", text: body, requestId: requestId })
  }

  // With files: the bridge uploads them, then sends the message; the draft and the chips
  // stay until upload_done, so a failed upload can simply be sent again.
  function submitDraft() {
    noteActivity()
    if (uploading) return false
    if (attachments.length) {
      if (!connected) return false
      requestSerial++
      uploadRequestId = "omarchy-" + Date.now().toString(36) + "-" + requestSerial + "-" + Math.random().toString(36).slice(2, 8)
      if (!send({ type: "upload_files", requestId: uploadRequestId, text: String(draft || "").trim(),
        paths: attachments.map(function(file) { return file.path }) })) return false
      uploading = true
      uploadStatus = "Uploading…"
      return true
    }
    if (!sendText(draft)) return false
    draft = ""
    return true
  }

  function finishUpload() {
    uploading = false
    uploadRequestId = ""
    uploadStatus = ""
  }

  function abort() {
    return send({ type: "abort" })
  }

  function start() {
    if (!configured) return
    fatalReason = ""
    fatalMessage = ""
    ready = false
    connection = "connecting"
    bridge.running = true
  }

  function restart() {
    if (bridge.running) {
      restartPending = true
      stopping = true
      bridge.running = false
    } else {
      start()
    }
  }

  function showNotice(text, level) {
    noteActivity()
    notice = String(text || "")
    noticeLevel = String(level || "info")
    noticeTimer.restart()
  }

  function fatalText(msg) {
    if (msg.reason === "unauthorized") return "The daemon rejected the token in " + tokenFile + "."
    if (msg.reason === "bad_protocol") return "The daemon does not speak protocol v1."
    return String(msg.message || msg.reason || "The bridge stopped.")
  }

  // --- conversation -------------------------------------------------------

  // `at`: milliseconds, 0 when the time is unknown (history from daemons without `at`).
  function messageRow(id, role, text, phase, error, activities, segments, reasoning, at, attachments) {
    return {
      at: TimeFormat.timestampOf(at),
      msgId: String(id || ""),
      role: role === "user" ? "user" : "assistant",
      text: String(text || ""),
      phase: String(phase || "done"),
      error: String(error || ""),
      activities: JSON.stringify(Array.isArray(activities) ? activities : []),
      segments: JSON.stringify(Array.isArray(segments) ? segments : []),
      reasoning: String(reasoning || ""),
      attachments: attachmentsJson(attachments)
    }
  }

  function resetMessages(list) {
    messages.clear()
    var index = ({})
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {}
      index[String(m.id)] = messages.count
      messages.append(messageRow(m.id, m.role, m.text, "done", "", m.activities, m.segments, m.reasoning, m.at, m.attachments))
    }
    indexById = index
  }

  // Index of the message with this id, appending an empty one when it is new.
  function ensureMessage(id, role) {
    var key = String(id || "")
    var at = indexById[key]
    if (at !== undefined && at < messages.count && messages.get(at).msgId === key) return at
    at = messages.count
    messages.append(messageRow(key, role, "", role === "user" ? "done" : "streaming", "", []))
    indexById[key] = at
    return at
  }

  // The daemon's `at` when it sends one; otherwise the time this client first saw the message.
  function stamp(at, value) {
    var given = TimeFormat.timestampOf(value)
    if (given) messages.setProperty(at, "at", given)
    else if (!messages.get(at).at) messages.setProperty(at, "at", Date.now())
  }

  function upsertActivity(at, activity) {
    if (!activity || !activity.id) return
    var list = []
    try { list = JSON.parse(messages.get(at).activities) } catch (e) { list = [] }
    var found = false
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === activity.id) {
        list[i] = activity
        found = true
        break
      }
    }
    if (!found) list.push(activity)
    messages.setProperty(at, "activities", JSON.stringify(list))
  }

  function handleLine(line) {
    if (!String(line).trim()) return
    var msg
    try {
      msg = JSON.parse(line)
    } catch (e) {
      console.warn("omarchy-gentle-dot: bad bridge line", String(line).slice(0, 200))
      return
    }
    if (!msg || typeof msg !== "object") return

    if (msg.type === "bridge" ? String(msg.state || "") !== connection : activityTypes.indexOf(msg.type) >= 0) noteActivity()
    var at
    switch (msg.type) {
      case "bridge":
        if (msg.state !== "open") {
          ready = false
          endTurn()
        }
        if (msg.state === "fatal") {
          fatalReason = String(msg.reason || "")
          fatalMessage = fatalText(msg)
        }
        connection = String(msg.state || "")
        break
      case "bridge_error":
        if (msg.code === "not_connected") showNotice(msg.message, "warning")
        else console.warn("omarchy-gentle-dot bridge:", msg.code, msg.message)
        break
      case "ready":
        // attach() replays pending asks immediately after ready, BEFORE the
        // asynchronous get_history response. History must not clear that replay.
        clearAsks()
        forgetFetches([], ["network"])
        endTurn()
        ready = true
        agentState = String(msg.agentState || "")
        model = String(msg.model || "")
        send({ type: "get_history" })
        break
      case "ask":
        receiveAsk(msg.ask)
        break
      case "ask_resolved":
        removeAsk(msg.requestId)
        break
      case "agent_state":
        agentState = String(msg.state || "")
        if (agentState === "idle" || agentState === "error") endTurn()
        break
      case "history":
        resetMessages(Array.isArray(msg.messages) ? msg.messages : [])
        break
      case "user_message":
        at = ensureMessage(msg.messageId, "user")
        messages.setProperty(at, "text", String(msg.text || ""))
        if (Array.isArray(msg.attachments)) messages.setProperty(at, "attachments", attachmentsJson(msg.attachments))
        stamp(at, msg.at)
        break
      case "message_delta":
        at = ensureMessage(msg.messageId, "assistant")
        stamp(at, undefined)
        messages.setProperty(at, "text", messages.get(at).text + String(msg.delta || ""))
        messages.setProperty(at, "phase", "streaming")
        answering = true
        break
      case "reasoning_delta":
        at = ensureMessage(msg.messageId, "assistant")
        messages.setProperty(at, "reasoning", messages.get(at).reasoning + String(msg.delta || ""))
        break
      case "message_done":
        at = ensureMessage(msg.messageId, "assistant")
        messages.setProperty(at, "text", String(msg.text || ""))
        messages.setProperty(at, "segments", JSON.stringify(Array.isArray(msg.segments) ? msg.segments : []))
        if (typeof msg.reasoning === "string") messages.setProperty(at, "reasoning", msg.reasoning)
        messages.setProperty(at, "error", String(msg.error || ""))
        messages.setProperty(at, "phase", msg.error ? "error" : (msg.stopped ? "stopped" : "done"))
        stamp(at, msg.at)
        answering = false
        break
      case "activity":
        at = ensureMessage(msg.messageId, "assistant")
        upsertActivity(at, msg.activity)
        trackActivity(msg.activity)
        break
      case "files_inspected":
        acceptInspected(Array.isArray(msg.files) ? msg.files : [])
        break
      case "upload_progress":
        if (msg.requestId !== uploadRequestId) break
        uploadStatus = "Uploading " + String(msg.name || "") + " (" + (Number(msg.index) + 1) + "/" + Number(msg.count)
          + ") · " + (msg.total > 0 ? Math.round(100 * msg.loaded / msg.total) : 100) + "%"
        break
      case "upload_done":
        rememberUploads(Array.isArray(msg.files) ? msg.files : [])
        if (msg.requestId !== uploadRequestId) break
        finishUpload()
        attachments = []
        draft = ""
        break
      case "upload_error":
        if (msg.requestId !== uploadRequestId) break
        finishUpload()
        showNotice(msg.message || "The upload failed.", "error")
        break
      case "attachment_cached":
        fetchFinished(msg, msg.path ? { state: "ready", path: String(msg.path), mime: String(msg.mime || "") }
          : { state: "failed", code: "network" })
        break
      case "attachment_error":
        fetchFinished(msg, { state: "failed", code: String(msg.code || "") })
        break
      case "toast":
        showNotice(msg.message, msg.level)
        break
      case "error":
        showNotice(msg.message || msg.code, "error")
        break
    }
    message(msg)
  }

  Timer {
    interval: 100
    repeat: true
    running: client.pendingAsks.length > 0
    onTriggered: client.expireAsks()
  }

  Timer {
    interval: client.clockInterval
    repeat: true
    running: true
    onTriggered: client.now = Date.now()
  }

  Timer {
    interval: client.sleepCheckInterval
    repeat: true
    running: client.avatarSleepMinutes > 0
    onTriggered: client.checkSleep()
  }

  Timer {
    id: noticeTimer
    interval: 8000
    onTriggered: client.notice = ""
  }

  // Start, or restart once, after a burst of setting changes.
  Timer {
    id: settingsDebounce
    interval: 300
    onTriggered: client.restart()
  }

  Process {
    id: bridge
    command: [client.nodePath, client.bridgePath, "--url", client.serverUrl, "--token-file", client.tokenFile]
    stdinEnabled: true

    stdout: SplitParser {
      onRead: function(line) { client.handleLine(line) }
    }

    stderr: SplitParser {
      onRead: function(line) { console.warn("omarchy-gentle-dot bridge:", line) }
    }

    onExited: function(exitCode) {
      client.ready = false
      client.finishUpload()
      client.forgetFetches(["loading"], ["network"])
      if (client.stopping) {
        client.stopping = false
        client.connection = "stopped"
      } else if (client.connection !== "fatal") {
        client.fatalReason = "bridge_exited"
        client.fatalMessage = "The bridge exited with code " + exitCode + "."
        client.connection = "fatal"
      }
      if (client.restartPending) {
        client.restartPending = false
        client.start()
      }
    }
  }

  Timer {
    id: testTimer
    interval: 6000
    onTriggered: client.finishTest(false, "Unreachable (no answer within 6 s)")
  }

  Process {
    id: tester
    stdinEnabled: true

    stdout: SplitParser {
      onRead: function(line) { client.handleTestLine(line) }
    }

    onExited: function(exitCode) {
      client.finishTest(false, "The test bridge exited with code " + exitCode)
    }
  }

  Process {
    id: tokenWriter
    property string secret: ""
    property var done: null
    stdinEnabled: true

    onStarted: {
      write(secret + "\n")
      secret = ""
    }

    onExited: function(exitCode) {
      var callback = done
      done = null
      secret = ""
      if (callback) callback(exitCode === 0)
    }
  }

  Process {
    id: clipboardTypes
    property var fallback: null
    stdout: StdioCollector { id: clipboardTypesOut; waitForEnd: true }
    onExited: function(exitCode) {
      // Let stdout settle before reading the list.
      Qt.callLater(function() { client.clipboardTypesListed(exitCode, clipboardTypesOut.text) })
    }
  }

  Process {
    id: clipboardSaver
    property string path: ""
    onExited: function(exitCode) {
      if (exitCode === 0) client.addAttachmentPaths([path])
      else client.showNotice("Could not read the image on the clipboard.", "error")
    }
  }

  Process {
    id: textSaver
    property string path: ""
    property string text: ""
    onStarted: {
      write(text)
      text = ""
      // Closing stdin ends cat's input.
      stdinEnabled = false
    }
    onExited: function(exitCode) {
      text = ""
      if (exitCode === 0) client.addAttachmentPaths([path])
      else client.showNotice("Could not attach the dropped text.", "error")
    }
  }

  Process {
    id: imageCopier
    property var done: null
    onExited: function(exitCode) {
      var callback = done
      done = null
      if (callback) callback(exitCode === 0)
    }
  }

  Process {
    id: tokenProbe
    property var done: null

    onExited: function(exitCode) {
      var callback = done
      done = null
      if (callback) callback(exitCode === 0)
    }
  }

  // Scriptable entry points: `quickshell ipc -p $OMARCHY_PATH/shell call omarchy-gentle-dot.client <fn>`.
  IpcHandler {
    target: "omarchy-gentle-dot.client"

    // `asks` returns protocol Ask objects; `answer <id> '{"value":"…"}'`,
    // '{"confirmed":true|false}' or '{"cancelled":true}' returns sent or an error.
    // Sticky panel state only: these entry points never send daemon messages.
    function pin(value: bool): void { client.setPinned(value) }
    function pinned(): bool { return client.panelPinned }
    // privacy true hides connection details on screen, false reveals them until the panel closes.
    function privacy(masked: bool): void { client.setPrivacyMasked(masked) }
    function privacyState(): string {
      return JSON.stringify({masked: client.privacyMasked, panelOpen: client.openPanels.length > 0})
    }
    function voiceStatus(): string {
      return JSON.stringify({model: client.voice.modelState, path: client.voice.modelPath,
        state: client.voice.state, seconds: client.voice.seconds, error: client.voice.error,
        transcript: client.voice.lastTranscript, draft: client.draft, sendOnStop: client.voiceSendOnStop,
        modelBusy: client.voice.modelBusy, basePath: client.voice.basePath})
    }
    function voiceTranscribeFile(path: string): string { return client.voice.transcribeFile(path) }
    function voiceRefresh(): string { return client.voice.manage("status") ? "checking" : "busy" }
    function clearDraft(): void { client.draft = "" }
    // The composer's status label (S17): {text, tone}.
    function statusLabel(): string { return JSON.stringify(client.status) }
    // Avatar sleep (S15.6): state, and a test-only switch (true: asleep now, false: wake up).
    function avatarState(): string {
      return JSON.stringify({asleep: client.asleep, minutes: client.avatarSleepMinutes,
        idleSeconds: Math.round((client.nowMs() - client.lastActivity) / 1000), engaged: client.engaged})
    }
    function avatarSleep(asleep: bool): string {
      client.forceSleep(asleep)
      return avatarState()
    }
    // Attachments waiting in the composer, as JSON; clearAttachments empties them (no upload).
    function attachments(): string { return JSON.stringify(client.attachments) }
    function clearAttachments(): void { if (!client.uploading) client.attachments = [] }
    function closeImage(): void { client.closeImage() }
    // detach false docks closed; the in-window Dock button docks open.
    function detach(value: bool): void { client.setDetached(value, null) }
    function detached(): bool { return client.detached }

    function asks(): string {
      client.expireAsks()
      return JSON.stringify(client.pendingAsks)
    }

    function answer(requestId: string, payloadJson: string): string {
      var payload
      try { payload = JSON.parse(payloadJson) } catch (e) { return "bad_payload" }
      return client.answer(requestId, payload)
    }

    function openSettings(): void {
      client.view = "settings"
      if (client.shell && typeof client.shell.summon === "function") client.shell.summon(client.pluginId, "{}")
    }

    function openChat(): void { client.openChat() }
    function notifyTest(): string { return client.notifier.notifyTest() }
    function notifyState(): string {
      return JSON.stringify({enabled: client.notificationsEnabled, sound: client.notificationSoundEnabled,
        doNotDisturb: client.notifier.doNotDisturb(), visible: client.panelVisible, lastNotifiedKind: client.notifier.lastKind})
    }

    // Persists a connection without the UI; `save "ws://127.0.0.1:4317/ws" "~/.gentle-dot/token"` resets to local.
    function save(url: string, tokenFile: string): string {
      if (!/^wss?:\/\//.test(url)) return "bad_url"
      return client.saveConnection(url, tokenFile) ? "saved" : "failed"
    }

    function test(url: string, tokenFile: string): string {
      return client.testConnection(url, tokenFile) ? "testing" : "busy"
    }

    function status(): string {
      var peers = []
      for (var i = 0; i < client.tailnet.peers.length; i++) {
        var p = client.tailnet.peers[i]
        peers.push(p.hostName + "|" + p.dnsName + "|" + p.os + "|" + (p.online ? "online" : "offline"))
      }
      return JSON.stringify({
        connection: client.connection,
        ready: client.ready,
        serverUrl: client.serverUrl,
        tokenFile: client.tokenFile,
        remote: client.remote,
        host: client.host,
        model: client.model,
        view: client.view,
        testState: client.testState,
        testMessage: client.testMessage,
        tailnetAvailable: client.tailnet.available,
        peers: peers
      })
    }
  }

  onViewChanged: if (view === "settings") tailnet.refresh()

  Component.onDestruction: {
    stopping = true
    bridge.running = false
    tester.running = false
  }
}
