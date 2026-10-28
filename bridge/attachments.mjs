// Attachment rules shared by the bridge and the QML client (import "bridge/attachments.mjs"
// as Attachments). Plain ECMAScript with no Node APIs, so QML can load it as is; QML's engine
// also lacks newer syntax such as optional catch bindings and String.prototype.matchAll.

// The daemon's limits (gentle-dot protocol ATTACHMENT_LIMITS); the daemon enforces them too.
export const ATTACHMENT_LIMITS = { fileBytes: 25 * 1024 * 1024, messageBytes: 50 * 1024 * 1024, files: 10 };

const PREVIEWABLE = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"];

export function isImage(mime) {
  return PREVIEWABLE.indexOf(String(mime || "").toLowerCase()) >= 0;
}

// "512 B", "2 KB", "1.5 MB" (the Gentle Dot app's wording).
export function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  const mb = size / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

const megabytes = bytes => `${Math.round(bytes / (1024 * 1024))} MB`;

// The type of an image or PDF from its first bytes (the daemon sniffs the same way).
export function sniffMime(head) {
  const bytes = head || [];
  const starts = (expected, at = 0) => {
    const list = typeof expected === "string" ? Array.from(expected, c => c.charCodeAt(0)) : expected;
    if (bytes.length < at + list.length) return false;
    for (let i = 0; i < list.length; i++) if (bytes[at + i] !== list[i]) return false;
    return true;
  };
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts("GIF87a") || starts("GIF89a")) return "image/gif";
  if (starts("RIFF") && starts("WEBP", 8)) return "image/webp";
  if (starts("BM")) return "image/bmp";
  if (starts("%PDF-")) return "application/pdf";
  return "application/octet-stream";
}

const BY_EXTENSION = { txt: "text/plain", log: "text/plain", md: "text/markdown", csv: "text/csv",
  json: "application/json", svg: "image/svg+xml", html: "text/html" };

// Sniffed type first, then a few text types by extension, else application/octet-stream.
export function mimeFor(name, head) {
  const sniffed = sniffMime(head);
  if (sniffed !== "application/octet-stream") return sniffed;
  const extension = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return (extension && BY_EXTENSION[extension[1]]) || sniffed;
}

// The daemon's upload endpoint for its WebSocket URL: ws://h:p/ws -> http://h:p/upload, wss -> https.
export function uploadEndpoint(wsUrl) {
  const match = String(wsUrl || "").match(/^ws(s?):\/\/([^\/?#]+)/i);
  return match ? `http${match[1].toLowerCase()}://${match[2]}/upload` : "";
}

// Stored attachments (S14.7): a patched daemon serves GET /upload/<uploadId>/<name>. Both parts are
// checked before they go into an address or a cache path.
const UPLOAD_ID = /^u_[A-Za-z0-9_-]{22}$/;

export function validUploadId(value) {
  return typeof value === "string" && UPLOAD_ID.test(value);
}

// One plain file name, as the daemon stores it: no separators, NUL or control characters, nothing
// hidden (leading dot, which also rules out . and ..), at most 120 characters.
export function validStoredName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 120 && value.charAt(0) !== "."
    && !/[\/\\\u0000-\u001f\u007f]/.test(value);
}

// The download address for a stored file, or "" when the URL, id or name is not acceptable.
export function downloadUrl(wsUrl, uploadId, name) {
  const base = uploadEndpoint(wsUrl);
  return base && validUploadId(uploadId) && validStoredName(name) ? `${base}/${uploadId}/${encodeURIComponent(name)}` : "";
}

// Types fetched on their own for a thumbnail; anything else waits for the user's Open.
const AUTO_FETCHED = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function autoFetched(mime) {
  return AUTO_FETCHED.indexOf(String(mime || "").toLowerCase()) >= 0;
}

// file:// URL for a local path; # and ? are escaped too, so they stay part of the name.
export function fileUrl(path) {
  return `file://${encodeURI(String(path || "")).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

// Adds inspected files ({path, name, size, mime} or {path, name, error}) to the current list
// within the limits. Returns the new list and one plain message per refusal.
export function addWithinLimits(current, inspected, limits = ATTACHMENT_LIMITS) {
  const list = (current || []).slice();
  const errors = [];
  let total = list.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  for (const file of inspected || []) {
    if (!file || typeof file.path !== "string") continue;
    const name = String(file.name || file.path.split("/").pop() || "file");
    if (list.some(item => item.path === file.path)) continue;
    if (file.error) { errors.push(`${name} cannot be attached: ${file.error}`); continue; }
    if (list.length >= limits.files) { errors.push(`Too many files: up to ${limits.files} per message.`); break; }
    if (file.size > limits.fileBytes) { errors.push(`${name} is too large: up to ${megabytes(limits.fileBytes)} per file.`); continue; }
    if (total + file.size > limits.messageBytes) {
      errors.push(`${name} does not fit: up to ${megabytes(limits.messageBytes)} per message.`);
      continue;
    }
    total += file.size;
    list.push({ path: file.path, name, size: Number(file.size) || 0, mime: String(file.mime || "application/octet-stream") });
  }
  return { list, errors };
}

// file:///a%20b.png or /a b.png -> /a b.png; anything else (relative, other schemes) -> "".
export function localPathOf(value) {
  const text = String(value || "");
  if (text.startsWith("file://")) {
    try { return decodeURIComponent(text.replace(/^file:\/\/(localhost)?/, "")); } catch (e) { return ""; }
  }
  return text.startsWith("/") ? text : "";
}

// Image URLs the chat may load: https (fetched without any credentials) and local files.
export function allowedImageUrl(url) {
  const text = String(url || "").trim();
  if (/^https:\/\/[^\s/]+/i.test(text)) return text;
  const path = localPathOf(text);
  return path ? `file://${encodeURI(path)}` : "";
}

const IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/;
const HTML_IMAGE = /<img\b[^>]*>/gi;

// Splits Markdown prose into prose and image parts so images never reach Qt's Markdown
// renderer (which would fetch any scheme). Allowed images become {type:"image", url, alt};
// others, and raw <img> tags, become their alt text. Inline code is left untouched.
export function markdownParts(text) {
  const parts = [];
  let prose = "";
  const pushProse = () => { if (prose) parts.push({ type: "md", text: prose }); prose = ""; };
  const pieces = String(text || "").split(/(`+[^`]*?`+)/);
  for (const piece of pieces) {
    if (/^`/.test(piece)) { prose += piece; continue; }
    let last = 0;
    const plain = piece.replace(HTML_IMAGE, "");
    const pattern = new RegExp(IMAGE.source, "g");
    let match;
    while ((match = pattern.exec(plain))) {
      prose += plain.slice(last, match.index);
      last = match.index + match[0].length;
      const url = allowedImageUrl(match[2]);
      if (url) {
        pushProse();
        parts.push({ type: "image", url, alt: match[1] });
      } else prose += match[1];
    }
    prose += plain.slice(last);
  }
  pushProse();
  return parts.filter(part => part.type !== "md" || part.text.trim() !== "");
}
