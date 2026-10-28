// Message timestamps for the chat footer. Plain ECMAScript with no Node APIs: QML imports it
// (import "bridge/time-format.mjs" as TimeFormat) and node:test checks it with a fixed `now`.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A message's optional `at` (milliseconds, a string of them, or ISO 8601) as milliseconds;
// 0 means "no time", which shows no label.
export function timestampOf(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value !== "string" || !value.trim()) return 0;
  const ms = /^\d+$/.test(value.trim()) ? Number(value) : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

// "just now" (< 1 min), "N min ago" (< 1 h), "N h ago" (< 24 h), otherwise the local date:
// "Oct 26" this year, "Oct 26, 2025" for another year. A clock slightly ahead reads as just now.
export function relativeTime(at, now) {
  if (!(at > 0)) return "";
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const date = new Date(at);
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${day}, ${date.getFullYear()}`;
}
