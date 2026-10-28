// Remembered message times (S14.12). Daemons without `at` (S14.7) send history with no times, and
// their live and history message ids never match, so the bridge remembers when it first saw each
// message by content and adds that `at` to history; the daemon's own `at` always wins.
//
// A message is keyed by daemon (the --url origin) + conversationId + role + its whitespace-
// normalized text (attachment names for a files-only message) + occurrence index, the n-th
// message with that role and text in the conversation. Every part is an HMAC-SHA256 under a
// random salt kept in the file, so the file holds no message text, conversation id or host.
//
//   ${XDG_STATE_HOME:-~/.local/state}/omarchy-gentle-dot/message-times.json   (folder 0700, file 0600)
//   {"version":1,"salt":"<base64url>","conversations":{"<daemon>:<conversation>":
//     {"seen":<ms>,"times":{"u:<text>":[<ms>|null, ...]}}}}            (array position = occurrence)
//
// Occurrences count from the start of a page that starts the conversation (no `hasEarlier`). The
// daemon sends only its newest messages, though, so a page with `hasEarlier` is lined up from its
// newest end against the occurrences already known. A message never seen live gets no time.
import { createHmac, randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { privateDir } from "./private-dir.mjs";
import { normalized } from "./render.mjs";
import { timestampOf } from "./time-format.mjs";

export const TIME_LIMITS = {
  perConversation: 5000,
  total: 20000,
  maxAgeMs: 90 * 24 * 3600 * 1000,
  fileBytes: 16 * 1024 * 1024,
  // No conversation has this many messages with the same role and text.
  occurrences: 100000,
};

const VERSION = 1;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_MS = 3600 * 1000;

export function timesFile(env = process.env) {
  const state = env.XDG_STATE_HOME?.startsWith("/") ? env.XDG_STATE_HOME : join(homedir(), ".local", "state");
  return join(state, "omarchy-gentle-dot", "message-times.json");
}

const validTime = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

// The file's conversations, keeping only well-formed parts; null when the file is not ours.
function parse(text) {
  const data = JSON.parse(text);
  if (!data || data.version !== VERSION || typeof data.salt !== "string" || Buffer.from(data.salt, "base64url").length !== 32
    || !data.conversations || typeof data.conversations !== "object" || Array.isArray(data.conversations)) return null;
  const conversations = new Map();
  for (const [key, value] of Object.entries(data.conversations)) {
    const [daemon, conversation, extra] = key.split(":");
    if (!HASH.test(daemon || "") || !HASH.test(conversation || "") || extra !== undefined) continue;
    if (!value || !validTime(value.seen) || !value.times || typeof value.times !== "object") continue;
    const times = new Map();
    for (const [message, list] of Object.entries(value.times)) {
      if (!/^[ua]:[A-Za-z0-9_-]{43}$/.test(message) || !Array.isArray(list) || list.length > TIME_LIMITS.occurrences) continue;
      times.set(message, list.map((at) => (validTime(at) ? at : null)));
    }
    conversations.set(key, { seen: value.seen, times });
  }
  return { salt: data.salt, conversations };
}

function load(file) {
  const fresh = () => ({ salt: randomBytes(32).toString("base64url"), conversations: new Map(), fresh: true });
  let text;
  try {
    if (statSync(file).size > TIME_LIMITS.fileBytes) throw new SyntaxError("too large");
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (!(error instanceof SyntaxError)) return fresh();
  }
  try {
    const data = text === undefined ? null : parse(text);
    if (data) return data;
  } catch {
    // Not JSON: set aside below.
  }
  try {
    renameSync(file, `${file}.bak`);
  } catch {
    // Nothing to keep.
  }
  return fresh();
}

// The persisted record of first-seen times, written atomically a moment after it changes.
export function openTimeStore(file, { now = Date.now, delayMs = 1000, onError = () => {} } = {}) {
  const data = load(file);
  let timer = null;
  let dirty = false;

  const hash = (kind, value) => createHmac("sha256", Buffer.from(data.salt, "base64url")).update(`${kind}\0${value}`).digest("base64url");

  // Drops conversations not seen for 90 days, then the oldest times over each bound.
  const prune = () => {
    const oldest = (entries, limit) => {
      if (entries.length <= limit) return;
      entries.sort((a, b) => a[0] - b[0]);
      for (const [, list, index] of entries.slice(0, entries.length - limit)) list[index] = null;
    };
    const entriesOf = (conversation) => {
      const entries = [];
      for (const list of conversation.times.values()) list.forEach((at, index) => at && entries.push([at, list, index]));
      return entries;
    };
    const cutoff = now() - TIME_LIMITS.maxAgeMs;
    for (const [key, conversation] of data.conversations) {
      if (conversation.seen < cutoff) data.conversations.delete(key);
      else oldest(entriesOf(conversation), TIME_LIMITS.perConversation);
    }
    oldest([...data.conversations.values()].flatMap(entriesOf), TIME_LIMITS.total);
    for (const [key, conversation] of data.conversations) {
      for (const [message, list] of conversation.times) if (!list.some(Boolean)) conversation.times.delete(message);
      if (!conversation.times.size) data.conversations.delete(key);
    }
  };

  prune();

  const write = () => {
    privateDir(dirname(file));
    const conversations = {};
    for (const [key, { seen, times }] of data.conversations) conversations[key] = { seen, times: Object.fromEntries(times) };
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      const fd = openSync(tmp, "w", 0o600);
      try {
        fchmodSync(fd, 0o600);
        writeSync(fd, JSON.stringify({ version: VERSION, salt: data.salt, conversations }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* never written */ }
      throw error;
    }
  };

  let failed = false;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    try {
      prune();
      write();
    } catch (error) {
      if (!failed) onError(error);
      failed = true;
    }
  };

  const changed = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(flush, delayMs);
    timer.unref?.();
  };

  // A new file is written right away, so its key stays the same from the first message on.
  if (data.fresh) changed();

  return {
    conversationKey: (daemon, conversation) => `${hash("daemon", daemon)}:${hash("conversation", conversation)}`,
    messageKey: (role, kind, value) => `${role === "user" ? "u" : "a"}:${hash(kind, value)}`,
    get: (conversation, message, index) => data.conversations.get(conversation)?.times.get(message)?.[index] || 0,
    // How many occurrences of this message the store knows (including forgotten ones).
    count: (conversation, message) => data.conversations.get(conversation)?.times.get(message)?.length || 0,
    set(conversation, message, index, at) {
      if (!validTime(at) || !(index >= 0) || index >= TIME_LIMITS.occurrences) return;
      let entry = data.conversations.get(conversation);
      if (!entry) data.conversations.set(conversation, (entry = { seen: now(), times: new Map() }));
      const list = entry.times.get(message) || [];
      entry.times.set(message, list);
      if (list[index] === at) return;
      while (list.length < index) list.push(null);
      list[index] = at;
      entry.seen = now();
      changed();
    },
    touch(conversation) {
      const entry = data.conversations.get(conversation);
      if (!entry || now() - entry.seen < TOUCH_MS) return;
      entry.seen = now();
      changed();
    },
    flush,
  };
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return String(url);
  }
}

// Stamps and reconciles the daemon messages relayed for one --url; returns each message, with
// `at` added where the store knows it.
export function messageTimes(url, store, { now = Date.now } = {}) {
  const daemon = originOf(url);
  let conversation = "";
  let key = store.conversationKey(daemon, conversation);
  // Occurrences per message in the conversation so far, from the last history and live messages.
  let counts = new Map();
  // Whether the last history started at the conversation's first message.
  let complete = false;

  const open = (id) => {
    conversation = typeof id === "string" ? id : "";
    key = store.conversationKey(daemon, conversation);
    counts = new Map();
    complete = false;
  };

  const messageKey = (role, text, attachments) => {
    const words = normalized(String(text || ""));
    if (words) return store.messageKey(role, "text", words);
    const names = role === "user" && Array.isArray(attachments)
      ? attachments.map((file) => (file && typeof file.name === "string" ? file.name : "")).filter(Boolean) : [];
    return names.length ? store.messageKey(role, "attachments", names.join("\n")) : null;
  };

  const live = (message, role) => {
    const id = messageKey(role, message.text, message.attachments);
    if (!id) return message;
    const given = timestampOf(message.at);
    const index = counts.has(id) ? counts.get(id) : complete ? 0 : store.count(key, id);
    counts.set(id, index + 1);
    const at = given || now();
    store.set(key, id, index, at);
    return given ? message : { ...message, at };
  };

  // `fromStart`: the page starts the conversation; otherwise it ends with the newest message.
  const reconcile = (messages, fromStart) => {
    const ids = messages.map((m) => (m && typeof m === "object" ? messageKey(m.role === "user" ? "user" : "assistant", m.text, m.attachments) : null));
    const inPage = new Map();
    for (const id of ids) if (id) inPage.set(id, (inPage.get(id) || 0) + 1);
    const base = new Map([...inPage].map(([id, count]) => [id, fromStart ? 0 : Math.max(0, store.count(key, id) - count)]));
    const seen = new Map();
    const result = messages.map((m, i) => {
      const id = ids[i];
      if (!id) return m;
      const index = base.get(id) + (seen.get(id) || 0);
      seen.set(id, (seen.get(id) || 0) + 1);
      const given = timestampOf(m.at);
      if (given) {
        store.set(key, id, index, given);
        return m;
      }
      const at = store.get(key, id, index);
      return at ? { ...m, at } : m;
    });
    store.touch(key);
    return { result, counts: new Map([...inPage].map(([id, count]) => [id, base.get(id) + count])) };
  };

  return {
    relay(message) {
      if (!message || typeof message !== "object") return message;
      switch (message.type) {
        case "ready":
          open(message.conversationId);
          return message;
        case "history": {
          if (typeof message.conversationId === "string" && message.conversationId !== conversation) open(message.conversationId);
          if (!Array.isArray(message.messages)) return message;
          const fromStart = !message.hasEarlier;
          const page = reconcile(message.messages, fromStart);
          counts = page.counts;
          complete = fromStart;
          return { ...message, messages: page.result };
        }
        case "earlier":
          // A page in the middle has no known position; only the conversation's first page does.
          if (message.hasEarlier || !Array.isArray(message.messages)) return message;
          return { ...message, messages: reconcile(message.messages, true).result };
        case "user_message":
          return live(message, "user");
        case "message_done":
          return live(message, "assistant");
        default:
          return message;
      }
    },
  };
}
