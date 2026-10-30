// Remembered message times (S14.12): the bridge keeps when it first saw each message and adds
// that `at` to history that arrives without one; the daemon's own `at` always wins.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { messageTimes, openTimeStore, timesFile } from "../bridge/times.mjs";

const BRIDGE = fileURLToPath(new URL("../bridge/bridge.mjs", import.meta.url));
const DAY = 86400000;
const CONVERSATION = "conv-private-7f3a9c";

const scratch = [];
after(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))));

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const storePath = (state) => join(state, "omarchy-gentle-dot", "message-times.json");

// --- the module, with a fixed clock -------------------------------------------------------------

function clock(start = Date.UTC(2026, 9, 28, 12)) {
  let value = start;
  const now = () => value;
  now.advance = (ms) => { value += ms; };
  now.set = (ms) => { value = ms; };
  return now;
}

async function relayer(now, file, url = "ws://127.0.0.1:4317/ws") {
  const store = openTimeStore(file, { now, delayMs: 60000 });
  return { store, times: messageTimes(url, store, { now }) };
}

const history = (messages, extra = {}) => ({ type: "history", conversationId: CONVERSATION, messages, ...extra });
const user = (id, text, extra = {}) => ({ id, role: "user", text, activities: [], ...extra });
const reply = (id, text, extra = {}) => ({ id, role: "assistant", text, activities: [], ...extra });

test("timesFile follows XDG_STATE_HOME, else ~/.local/state", () => {
  assert.equal(timesFile({ XDG_STATE_HOME: "/x/state" }), "/x/state/omarchy-gentle-dot/message-times.json");
  assert.match(timesFile({}), /\/\.local\/state\/omarchy-gentle-dot\/message-times\.json$/);
  assert.match(timesFile({ XDG_STATE_HOME: "relative/dir" }), /\/\.local\/state\/omarchy-gentle-dot\/message-times\.json$/);
});

test("live messages are stamped and reconciled; whitespace-only differences still match", async () => {
  const now = clock();
  const { times } = await relayer(now, storePath(await tempDir("gd-times-")));
  times.relay({ type: "ready", agentState: "idle", conversationId: CONVERSATION });
  times.relay(history([]));
  const sent = times.relay({ type: "user_message", messageId: "u1", text: "Hello   there\n" });
  assert.deepEqual(sent, { type: "user_message", messageId: "u1", text: "Hello   there\n", at: now() });
  const asked = now();
  now.advance(4000);
  const done = times.relay({ type: "message_done", messageId: "m1", text: "Hi!\n\n  How can I help?" });
  assert.equal(done.at, asked + 4000);

  const page = times.relay(history([
    user("h1", " Hello there"), reply("h2", "Hi! How can I help?"), user("h3", "never seen live"), reply("h4", ""),
  ]));
  assert.equal(page.messages[0].at, asked);
  assert.equal(page.messages[1].at, asked + 4000);
  assert.equal("at" in page.messages[2], false, "no time invented for an unknown message");
  assert.equal("at" in page.messages[3], false, "no time for an empty message");
  assert.equal(page.messages[1].text, "Hi! How can I help?", "the message itself is not changed");
});

test("duplicates map by occurrence, and a message seen once is not reused for its twin", async () => {
  const now = clock();
  const { times } = await relayer(now, storePath(await tempDir("gd-times-")));
  times.relay({ type: "ready", conversationId: CONVERSATION });
  times.relay(history([user("h1", "ok")]));
  const first = 1000; // the daemon's time for the "ok" already in history
  times.relay(history([user("h1", "ok", { at: first })]));
  const second = times.relay({ type: "user_message", messageId: "u2", text: "ok" }).at;
  now.advance(60000);
  const third = times.relay({ type: "user_message", messageId: "u3", text: "ok" }).at;
  assert.equal(third - second, 60000);

  const page = times.relay(history([user("a", "ok"), reply("b", "done"), user("c", "ok"), user("d", "ok"), user("e", "ok")]));
  assert.deepEqual(page.messages.map((m) => m.at), [first, undefined, second, third, undefined]);
});

test("a tail page (hasEarlier) lines its duplicates up from the newest end", async () => {
  const now = clock();
  const { times } = await relayer(now, storePath(await tempDir("gd-times-")));
  times.relay({ type: "ready", conversationId: CONVERSATION });
  times.relay(history([]));
  const at = [];
  for (let i = 0; i < 3; i++) {
    at.push(times.relay({ type: "user_message", messageId: `u${i}`, text: "ok" }).at);
    now.advance(1000);
  }
  // The window slid: only the two newest "ok" are still in the page.
  const page = times.relay(history([user("x", "ok"), user("y", "ok")], { hasEarlier: true }));
  assert.deepEqual(page.messages.map((m) => m.at), [at[1], at[2]]);
  // A new live "ok" after a tail page continues the count instead of reusing a slot.
  now.advance(1000);
  const fourth = times.relay({ type: "user_message", messageId: "u3", text: "ok" }).at;
  const later = times.relay(history([user("x", "ok"), user("y", "ok"), user("z", "ok")], { hasEarlier: true }));
  assert.deepEqual(later.messages.map((m) => m.at), [at[1], at[2], fourth]);
});

test("conversations and daemons never share times", async () => {
  const now = clock();
  const file = storePath(await tempDir("gd-times-"));
  const { store, times } = await relayer(now, file);
  times.relay({ type: "ready", conversationId: CONVERSATION });
  times.relay(history([]));
  times.relay({ type: "user_message", messageId: "u1", text: "same words" });
  const other = times.relay({ type: "history", conversationId: "another", messages: [user("h", "same words")] });
  assert.equal("at" in other.messages[0], false);
  const remote = messageTimes("wss://elsewhere.example.ts.net/ws", store, { now });
  remote.relay({ type: "ready", conversationId: CONVERSATION });
  const page = remote.relay(history([user("h", "same words")]));
  assert.equal("at" in page.messages[0], false);
  // Back on the first daemon and conversation, it still matches.
  times.relay({ type: "ready", conversationId: CONVERSATION });
  assert.equal(times.relay(history([user("h", "same words")])).messages[0].at, now());
});

test("the daemon's `at` wins, live and in history, and updates the store", async () => {
  const now = clock();
  const file = storePath(await tempDir("gd-times-"));
  const { store, times } = await relayer(now, file);
  times.relay({ type: "ready", conversationId: CONVERSATION });
  times.relay(history([]));
  const live = { type: "user_message", messageId: "u1", text: "question", at: 1234 };
  assert.deepEqual(times.relay(live), live);
  times.relay({ type: "message_done", messageId: "m1", text: "answer" });
  assert.equal(times.relay(history([user("a", "question"), reply("b", "answer")])).messages[1].at, now());

  const patched = times.relay(history([user("a", "question", { at: 5000 }), reply("b", "answer", { at: 7000 })]));
  assert.deepEqual(patched.messages.map((m) => m.at), [5000, 7000]);
  store.flush();
  const reopened = await relayer(now, file);
  reopened.times.relay({ type: "ready", conversationId: CONVERSATION });
  assert.deepEqual(reopened.times.relay(history([user("a", "question"), reply("b", "answer")])).messages.map((m) => m.at), [5000, 7000]);
});

test("attachment-only user messages are matched by their file names", async () => {
  const now = clock();
  const { times } = await relayer(now, storePath(await tempDir("gd-times-")));
  times.relay({ type: "ready", conversationId: CONVERSATION });
  times.relay(history([]));
  const files = [{ name: "shot.png", size: 10, mime: "image/png" }, { name: "notes.txt", size: 3, mime: "text/plain" }];
  const sent = times.relay({ type: "user_message", messageId: "u1", text: "", attachments: files });
  assert.equal(sent.at, now());
  const page = times.relay(history([
    user("a", "", { attachments: files }),
    user("b", "", { attachments: [files[0]] }),
  ]));
  assert.equal(page.messages[0].at, now());
  assert.equal("at" in page.messages[1], false);
});

test("an earlier page is reconciled only when it starts the conversation", async () => {
  const now = clock();
  const { times } = await relayer(now, storePath(await tempDir("gd-times-")));
  times.relay({ type: "ready", conversationId: CONVERSATION });
  times.relay(history([]));
  const at = times.relay({ type: "user_message", messageId: "u1", text: "first words" }).at;
  const start = times.relay({ type: "earlier", before: "s0-9", messages: [user("s0-1", "first words")], hasEarlier: false });
  assert.equal(start.messages[0].at, at);
  const middle = { type: "earlier", before: "s0-9", messages: [user("s0-5", "first words")], hasEarlier: true };
  assert.deepEqual(times.relay(middle), middle);
});

test("the store is bounded: 5000 per conversation, 20000 in all, oldest first", async () => {
  const now = clock();
  const file = storePath(await tempDir("gd-times-"));
  const { store, times } = await relayer(now, file);
  const record = (conversation, count) => {
    times.relay({ type: "ready", conversationId: conversation });
    times.relay({ type: "history", conversationId: conversation, messages: [] });
    for (let i = 0; i < count; i++) {
      times.relay({ type: "user_message", messageId: `u${i}`, text: `${conversation} message ${i}` });
      now.advance(1);
    }
  };
  record("one", 5001);
  for (const name of ["two", "three", "four"]) record(name, 5000);
  record("five", 2);
  store.flush();

  const { times: reopened } = await relayer(now, file);
  const check = (conversation, i) => {
    reopened.relay({ type: "ready", conversationId: conversation });
    return reopened.relay({ type: "history", conversationId: conversation, messages: [user("h", `${conversation} message ${i}`)] }).messages[0].at;
  };
  assert.equal(check("one", 0), undefined, "over 5000 in one conversation: the oldest goes");
  assert.equal(check("one", 1), undefined, "over 20000 in all: the oldest goes");
  assert.equal(check("one", 2), undefined, "over 20000 in all: the oldest goes");
  assert.equal(typeof check("one", 3), "number");
  assert.equal(typeof check("one", 5000), "number");
  assert.equal(typeof check("five", 1), "number");
});

test("conversations not seen for 90 days are dropped", async () => {
  const now = clock();
  const file = storePath(await tempDir("gd-times-"));
  const { store, times } = await relayer(now, file);
  for (const conversation of ["old", "recent"]) {
    times.relay({ type: "ready", conversationId: conversation });
    times.relay({ type: "history", conversationId: conversation, messages: [] });
    times.relay({ type: "user_message", messageId: "u1", text: "kept?" });
  }
  store.flush();
  now.advance(60 * DAY);
  const seen = await relayer(now, file);
  seen.times.relay({ type: "ready", conversationId: "recent" });
  seen.times.relay({ type: "history", conversationId: "recent", messages: [] });
  seen.store.flush();
  now.advance(31 * DAY);
  const { times: later } = await relayer(now, file);
  const at = (conversation) => {
    later.relay({ type: "ready", conversationId: conversation });
    return later.relay({ type: "history", conversationId: conversation, messages: [user("h", "kept?")] }).messages[0].at;
  };
  assert.equal(at("old"), undefined);
  assert.equal(typeof at("recent"), "number");
});

test("a corrupt store is kept as .bak and replaced by a fresh one", async () => {
  const state = await tempDir("gd-times-");
  const file = storePath(state);
  await mkdir(join(state, "omarchy-gentle-dot"), { recursive: true });
  await writeFile(file, "{not json");
  const now = clock();
  const { store, times } = await relayer(now, file);
  assert.equal(await readFile(`${file}.bak`, "utf8"), "{not json");
  times.relay({ type: "ready", conversationId: CONVERSATION });
  times.relay(history([]));
  times.relay({ type: "user_message", messageId: "u1", text: "after recovery" });
  store.flush();
  const { times: reopened } = await relayer(now, file);
  reopened.relay({ type: "ready", conversationId: CONVERSATION });
  assert.equal(reopened.relay(history([user("h", "after recovery")])).messages[0].at, now());
});

// --- through the bridge, against a fake daemon ---------------------------------------------------

async function fakeDaemon() {
  const http = createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const server = new WebSocketServer({ server: http, path: "/ws" });
  const connections = [];
  const waiters = [];
  server.on("connection", (socket) => {
    const conn = { socket, send: (message) => socket.send(JSON.stringify(message)) };
    socket.once("message", () => {
      connections.push(conn);
      for (const waiter of waiters.splice(0)) waiter(conn);
    });
  });
  const { port } = http.address();
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    port,
    // The next connection that said hello.
    hello: (index) => connections[index] ? Promise.resolve(connections[index]) : new Promise((resolve) => waiters.push(resolve)),
    close: () => new Promise((resolve) => {
      for (const client of server.clients) client.terminate();
      server.close(() => { http.closeAllConnections(); http.close(() => resolve()); });
    }),
  };
}

function runBridge(url, tokenPath, state) {
  const child = spawn(process.execPath, [BRIDGE, "--url", url, "--token-file", tokenPath], {
    env: { ...process.env, XDG_STATE_HOME: state },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  let stderr = "";
  let buffer = "";
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      // Each line is an envelope {from, msg} (S22.1); the tests read the messages.
      lines.push(JSON.parse(buffer.slice(0, index)).msg);
      buffer = buffer.slice(index + 1);
      for (const waiter of [...waiters]) waiter();
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return {
    child,
    lines,
    exited,
    stderr: () => stderr,
    waitFor(predicate, timeoutMs = 4000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = lines.find(predicate);
          if (!found) return;
          waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          resolve(found);
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error(`timed out; lines: ${JSON.stringify(lines)}`));
        }, timeoutMs);
        waiters.push(check);
        check();
      });
    },
  };
}

async function setup(t) {
  const daemon = await fakeDaemon();
  t.after(daemon.close);
  const state = await tempDir("gd-times-state-");
  const tokens = await tempDir("gd-times-token-");
  const token = join(tokens, "token");
  await writeFile(token, "secret-token\n");
  const start = async (url = daemon.url) => {
    const bridge = runBridge(url, token, state);
    t.after(() => bridge.child.kill("SIGKILL"));
    return bridge;
  };
  return { daemon, state, token, start };
}

// Connects a bridge, opens the conversation and sends a scripted live exchange.
async function liveExchange(daemon, bridge, connection) {
  const conn = await daemon.hello(connection);
  conn.send({ type: "ready", agentState: "idle", conversationId: CONVERSATION });
  conn.send(history([]));
  conn.send({ type: "user_message", messageId: "u1", text: "Remember   this\nplease" });
  conn.send({ type: "message_delta", messageId: "m1", delta: "Sure,\n\nnoted." });
  conn.send({ type: "message_done", messageId: "m1", text: "Sure, noted." });
  const sent = await bridge.waitFor((line) => line.type === "user_message");
  const done = await bridge.waitFor((line) => line.type === "message_done");
  return { conn, sent, done };
}

test("bridge: live times survive a restart, the file is private and holds no text or host", async (t) => {
  const { daemon, state, start } = await setup(t);
  const before = Date.now();
  const first = await start();
  const { sent, done } = await liveExchange(daemon, first, 0);
  assert.ok(sent.at >= before && sent.at <= Date.now(), "live user_message carries the time it was seen");
  assert.ok(done.at >= sent.at, "message_done carries the time it was seen");
  assert.equal(done.text, "Sure,\n\nnoted.", "streamed whitespace is still preserved");
  first.child.stdin.end();
  assert.deepEqual(await first.exited, { code: 0, signal: null });

  const file = storePath(state);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(state, "omarchy-gentle-dot"))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(state, "omarchy-gentle-dot")), ["message-times.json"]);
  const raw = await readFile(file, "utf8");
  for (const secret of ["Remember", "this", "please", "Sure", "noted", CONVERSATION, "127.0.0.1", String(daemon.port), "ws://"]) {
    assert.equal(raw.includes(secret), false, `store contains ${secret}`);
  }

  const second = await start();
  const conn = await daemon.hello(1);
  conn.send({ type: "ready", agentState: "idle", conversationId: CONVERSATION });
  conn.send(history([user("h1", "Remember this please"), reply("h2", "Sure,\nnoted."), user("h3", "unknown")]));
  const page = await second.waitFor((line) => line.type === "history");
  assert.deepEqual(page.messages.map((m) => m.at), [sent.at, done.at, undefined]);
  assert.equal(first.stderr() + second.stderr(), "");
});

test("bridge: the store file is created on start, private, even before anything is remembered", async (t) => {
  const { daemon, state, start } = await setup(t);
  const bridge = await start();
  const conn = await daemon.hello(0);
  conn.send({ type: "ready", conversationId: CONVERSATION });
  conn.send(history([user("h1", "Loaded from history")]));
  await bridge.waitFor((line) => line.type === "history");
  bridge.child.stdin.end();
  await bridge.exited;
  assert.equal((await stat(storePath(state))).mode & 0o777, 0o600);
  const raw = await readFile(storePath(state), "utf8");
  for (const secret of ["Loaded", "history", CONVERSATION, "127.0.0.1"]) assert.equal(raw.includes(secret), false, secret);
});

test("bridge: SIGTERM writes pending times before the bridge stops", async (t) => {
  const { daemon, start } = await setup(t);
  const first = await start();
  const { sent } = await liveExchange(daemon, first, 0);
  assert.equal(typeof sent.at, "number");
  first.child.kill("SIGTERM");
  assert.deepEqual(await first.exited, { code: null, signal: "SIGTERM" });

  const second = await start();
  const conn = await daemon.hello(1);
  conn.send({ type: "ready", conversationId: CONVERSATION });
  conn.send(history([user("h1", "Remember this please")]));
  assert.equal((await second.waitFor((line) => line.type === "history")).messages[0].at, sent.at);
});

test("bridge: another daemon URL never gets this daemon's times", async (t) => {
  const { daemon, state, token, start } = await setup(t);
  const first = await start();
  await liveExchange(daemon, first, 0);
  first.child.stdin.end();
  await first.exited;

  const other = await fakeDaemon();
  t.after(other.close);
  const bridge = runBridge(other.url, token, state);
  t.after(() => bridge.child.kill("SIGKILL"));
  const conn = await other.hello(0);
  conn.send({ type: "ready", conversationId: CONVERSATION });
  conn.send(history([user("h1", "Remember this please")]));
  assert.equal("at" in (await bridge.waitFor((line) => line.type === "history")).messages[0], false);
});

test("bridge: a corrupt store file is set aside and a fresh one written 0600", async (t) => {
  const { daemon, state, start } = await setup(t);
  const dir = join(state, "omarchy-gentle-dot");
  await mkdir(dir, { recursive: true, mode: 0o755 });
  await writeFile(storePath(state), "\u0000garbage", { mode: 0o644 });
  const bridge = await start();
  await liveExchange(daemon, bridge, 0);
  bridge.child.stdin.end();
  assert.deepEqual(await bridge.exited, { code: 0, signal: null });
  assert.equal(await readFile(`${storePath(state)}.bak`, "utf8"), "\u0000garbage");
  assert.equal((await stat(storePath(state))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const raw = await readFile(storePath(state), "utf8");
  assert.doesNotThrow(() => JSON.parse(raw));
  assert.equal(bridge.stderr(), "");
});
