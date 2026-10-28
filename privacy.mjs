// Masks connection details (hosts, tailnet DNS names, IPs, URLs, token file paths) for
// screen sharing. Plain ECMAScript with no Node APIs: QML imports it
// (import "privacy.mjs" as Privacy) and node:test checks it.
//
// Every hidden value becomes the same fixed placeholder, so neither its length nor any of
// its characters show. URLs keep their scheme and the daemon's own paths (/ws, /health),
// which say nothing about the machine: "wss://••••••••/ws".

export const MASK = "••••••••";

// Paths that are the same on every machine and appear in the setup instructions.
const PUBLIC_PATHS = ["~/.gentle-dot/token"];
const SAFE_URL_PATHS = ["", "/", "/ws", "/health"];

// Punctuation that ends a sentence rather than a URL or path.
const TRAILING = /[.,;:!?…]+$/;

const H = "[0-9A-Fa-f]{1,4}";
const IPV4 = "\\d{1,3}(?:\\.\\d{1,3}){3}";
// Each pattern captures the character before the match (or the start) instead of using a
// lookbehind, so a match only starts at a boundary and long runs are scanned once.
const URL_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]{0,15}:\/\/[^\s<>"'`()]+/g;
const EMAIL_PATTERN = /(^|[^A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?:\[[^\]\s]+\]|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)/g;
const BRACKETED_IPV6_PATTERN = /\[[0-9A-Za-z:.%_-]*:[0-9A-Za-z:.%_-]*\](?::\d{1,5})?/g;
const IPV6_PATTERN = new RegExp("(^|[^0-9A-Za-z_:.])(?:(?:" + H + ":){7}" + H + "|(?:" + H + ":){1,7}:(?:" + H
  + "(?::" + H + "){0,6})?|::" + H + "(?::" + H + "){0,6})(?:\\.\\d{1,3}){0,3}(?:%[0-9A-Za-z_.-]+)?(?![0-9A-Za-z_:])", "g");
const IPV4_PATTERN = new RegExp("(^|[^0-9A-Za-z_.])" + IPV4 + "(?::\\d{1,5})?(?![0-9A-Za-z_]|\\.\\d)", "g");
const PATH_PATTERN = /(^|[\s"'`(<=])(~\/[^\s"'`<>()]+|\/(?:[^\s\/"'`<>()]+\/)+[^\s"'`<>()]*)/g;
const DNS_PATTERN = /(^|[^0-9A-Za-z_.@-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9](?::\d{1,5})?(?![0-9A-Za-z_-]|\.[A-Za-z0-9])/g;

function text(value) {
  return value === null || value === undefined ? "" : String(value);
}

// A host, device name, port or token path: the placeholder, or "" when there is nothing to hide.
export function maskValue(value) {
  return text(value).trim() ? MASK : "";
}

// scheme://••••••••[/ws|/health|/••••••••][?••••••••]; anything that is not a URL is hidden whole.
export function maskUrl(value) {
  const url = text(value).trim();
  if (!url) return "";
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\/?#]*)([^?#]*)([?#].*)?$/.exec(url);
  if (!match) return MASK;
  const path = SAFE_URL_PATHS.indexOf(match[3]) >= 0 ? match[3] : "/" + MASK;
  return match[1] + "://" + MASK + path + (match[4] ? match[4][0] + MASK : "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Keeps the sentence punctuation after a URL or path outside the mask.
function maskTrimmed(token, mask) {
  const tail = TRAILING.exec(token);
  const core = tail ? token.slice(0, -tail[0].length) : token;
  return mask(core) + (tail ? tail[0] : "");
}

// Free text (notices, test results, hints) with every connection detail in it masked.
// `terms` are names known to be sensitive that no pattern can recognise, such as a tailnet
// device name without dots; they match whole words, case-insensitively, from three letters on.
export function maskText(value, terms) {
  let out = text(value);
  if (!out) return out;
  const known = (Array.isArray(terms) ? terms : [])
    .map(term => text(term).trim())
    .filter((term, at, list) => term.length >= 3 && PUBLIC_PATHS.indexOf(term) < 0 && list.indexOf(term) === at)
    .sort((a, b) => b.length - a.length);
  for (const term of known) {
    out = out.replace(new RegExp("(^|[^A-Za-z0-9-])" + escapeRegExp(term) + "(?::\\d{1,5})?(?![A-Za-z0-9-])", "gi"), "$1" + MASK);
  }
  out = out.replace(URL_PATTERN, token => maskTrimmed(token, maskUrl));
  out = out.replace(EMAIL_PATTERN, "$1" + MASK);
  out = out.replace(BRACKETED_IPV6_PATTERN, MASK);
  out = out.replace(IPV6_PATTERN, "$1" + MASK);
  out = out.replace(IPV4_PATTERN, "$1" + MASK);
  out = out.replace(PATH_PATTERN, (all, before, path) =>
    before + maskTrimmed(path, core => PUBLIC_PATHS.indexOf(core) >= 0 ? core : MASK));
  out = out.replace(DNS_PATTERN, "$1" + MASK);
  return out;
}
