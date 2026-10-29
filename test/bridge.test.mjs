import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const BRIDGE = fileURLToPath(new URL("../bridge/bridge.mjs", import.meta.url));
// The bridge remembers message times under $XDG_STATE_HOME; never the real one in tests.
const STATE_HOME = mkdtempSync(join(tmpdir(), "gd-bridge-state-"));
after(() => rm(STATE_HOME, { recursive: true, force: true }));

// A fake Gentle Dot daemon: records every frame and lets the test script replies. `upload`
// answers POST /upload like the daemon (raw body, Bearer token, X-File-Name, X-Upload-Id);
// every request is recorded with its headers and body. `download` answers GET requests like
// GET /upload/<uploadId>/<name> (S14.7) and may write the response itself.
// Other local processes may probe any new listening port (dev-server detectors send `GET /`):
// a request that neither targets /upload nor carries a token is not the bridge's and is not recorded.
async function fakeDaemon(onConnection, { upload, download } = {}) {
  const uploads = [];
  const http = createServer((req, res) => {
    if (!req.url.startsWith("/upload") && req.headers.authorization === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === "GET" && download) {
      const record = { method: req.method, url: req.url, headers: req.headers };
      uploads.push(record);
      res.on("error", () => {});
      req.socket.on("error", () => {});
      download(record, res, req);
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      uploads.push(record);
      const answer = upload ? upload(record, uploads.length) : { status: 404, body: { code: "not_found", message: "no" } };
      if (answer.destroy) { req.socket.destroy(); return; }
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const server = new WebSocketServer({ server: http, path: "/ws" });
  const connections = [];
  server.on("connection", (socket, request) => {
    const conn = { socket, request, frames: [] };
    connections.push(conn);
    socket.on("message", (data) => conn.frames.push(JSON.parse(String(data))));
    onConnection?.(conn, connections.length);
  });
  const { port } = http.address();
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    connections,
    uploads,
    close: () => new Promise((resolve) => {
      for (const client of server.clients) client.terminate();
      server.close(() => { http.closeAllConnections(); http.close(() => resolve()); });
    }),
  };
}

async function tokenFile(content = "secret-token\n") {
  const dir = await mkdtemp(join(tmpdir(), "gd-bridge-"));
  const path = join(dir, "token");
  await writeFile(path, content);
  return path;
}

function runBridge(args, env = {}, bridgePath = BRIDGE) {
  const child = spawn(process.execPath, [bridgePath, ...args], {
    env: { ...process.env, XDG_STATE_HOME: STATE_HOME, ...env },
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
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      lines.push(JSON.parse(line));
      for (const waiter of [...waiters]) waiter();
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    child,
    lines,
    stderr: () => stderr,
    exited,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    waitFor(predicate, timeoutMs = 4000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = lines.find(predicate);
          if (found) {
            waiters.splice(waiters.indexOf(check), 1);
            clearTimeout(timer);
            resolve(found);
          }
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

const until = async (condition, timeoutMs = 4000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("says hello with the trimmed token and protocol 1, then relays daemon messages to stdout", async (t) => {
  const daemon = await fakeDaemon((conn) => {
    conn.socket.once("message", () => conn.socket.send(JSON.stringify({ type: "ready", seq: 1, agentState: "idle" })));
  });
  t.after(daemon.close);
  const bridge = runBridge(["--url", daemon.url, "--token-file", await tokenFile("  secret-token\n")]);
  t.after(() => bridge.child.kill());

  await bridge.waitFor((line) => line.type === "ready");
  // "reasoning": opt in to model reasoning; daemons without capabilities ignore the field.
  assert.deepEqual(daemon.connections[0].frames[0], { type: "hello", token: "secret-token", protocol: 1, capabilities: ["reasoning"] });
  assert.equal(daemon.connections[0].request.headers.origin, undefined);
  assert.deepEqual(
    bridge.lines.filter((line) => line.type === "bridge").map((line) => line.state),
    ["connecting", "open"],
  );
  assert.deepEqual(bridge.lines.find((line) => line.type === "ready"), { type: "ready", seq: 1, agentState: "idle" });
});

test("forwards stdin messages to the daemon unchanged", async (t) => {
  const daemon = await fakeDaemon();
  t.after(daemon.close);
  const bridge = runBridge(["--url", daemon.url, "--token-file", await tokenFile()]);
  t.after(() => bridge.child.kill());

  await bridge.waitFor((line) => line.type === "bridge" && line.state === "open");
  bridge.send({ type: "send", text: "hola", requestId: "r1" });
  await until(() => daemon.connections[0].frames.length === 2);
  assert.deepEqual(daemon.connections[0].frames[1], { type: "send", text: "hola", requestId: "r1" });
});

test("rejects a stdin line that is not a JSON object without sending it", async (t) => {
  const daemon = await fakeDaemon();
  t.after(daemon.close);
  const bridge = runBridge(["--url", daemon.url, "--token-file", await tokenFile()]);
  t.after(() => bridge.child.kill());

  await bridge.waitFor((line) => line.type === "bridge" && line.state === "open");
  bridge.child.stdin.write("not json\n");
  const error = await bridge.waitFor((line) => line.type === "bridge_error");
  assert.deepEqual(error, { type: "bridge_error", code: "bad_input", message: "stdin line is not a JSON object" });
  assert.equal(daemon.connections[0].frames.length, 1);
});

test("reports not_connected for messages sent while the socket is down", async (t) => {
  const bridge = runBridge(["--url", "ws://127.0.0.1:9/ws", "--token-file", await tokenFile()]);
  t.after(() => bridge.child.kill());

  await bridge.waitFor((line) => line.type === "bridge" && line.state === "reconnecting");
  bridge.send({ type: "abort" });
  const error = await bridge.waitFor((line) => line.type === "bridge_error");
  assert.deepEqual(error, { type: "bridge_error", code: "not_connected", message: "not connected to the Gentle Dot daemon" });
});

for (const [code, reason] of [[4401, "unauthorized"], [4400, "bad_protocol"]]) {
  test(`stops for good on close ${code} and exits 2`, async (t) => {
    const daemon = await fakeDaemon((conn) => conn.socket.once("message", () => conn.socket.close(code, "nope")));
    t.after(daemon.close);
    const bridge = runBridge(["--url", daemon.url, "--token-file", await tokenFile()]);

    const fatal = await bridge.waitFor((line) => line.type === "bridge" && line.state === "fatal");
    assert.deepEqual(fatal, { type: "bridge", state: "fatal", code, reason });
    assert.equal(await bridge.exited, 2);
    assert.equal(daemon.connections.length, 1);
    assert.equal(bridge.stderr(), "");
  });
}

test("reconnects with backoff after the daemon drops the connection, saying hello again", async (t) => {
  const daemon = await fakeDaemon((conn, count) => {
    if (count === 1) conn.socket.once("message", () => conn.socket.terminate());
  });
  t.after(daemon.close);
  const bridge = runBridge(["--url", daemon.url, "--token-file", await tokenFile()]);
  t.after(() => bridge.child.kill());

  const reconnecting = await bridge.waitFor((line) => line.type === "bridge" && line.state === "reconnecting");
  assert.equal(reconnecting.retryInMs, 500);
  await until(() => daemon.connections.length === 2 && daemon.connections[1].frames.length === 1);
  assert.equal(daemon.connections[1].frames[0].type, "hello");
});

test("fails with token_missing when the token file does not exist", async () => {
  const bridge = runBridge(["--url", "ws://127.0.0.1:9/ws", "--token-file", "/nonexistent/gentle-dot/token"]);
  const fatal = await bridge.waitFor((line) => line.type === "bridge" && line.state === "fatal");
  assert.deepEqual(fatal, {
    type: "bridge",
    state: "fatal",
    reason: "token_missing",
    message: "cannot read the token file /nonexistent/gentle-dot/token",
  });
  assert.equal(await bridge.exited, 2);
});

test("expands ~ in the token file path", async (t) => {
  const daemon = await fakeDaemon();
  t.after(daemon.close);
  const home = await mkdtemp(join(tmpdir(), "gd-home-"));
  await writeFile(join(home, "token"), "home-token\n");
  const bridge = runBridge(["--url", daemon.url, "--token-file", "~/token"], { HOME: home });
  t.after(() => bridge.child.kill());

  await bridge.waitFor((line) => line.type === "bridge" && line.state === "open");
  await until(() => daemon.connections[0].frames.length === 1);
  assert.equal(daemon.connections[0].frames[0].token, "home-token");
});

test("rejects a URL that is not ws:// or wss:// and exits 2", async () => {
  const bridge = runBridge(["--url", "http://127.0.0.1:4317/ws", "--token-file", await tokenFile()]);
  const fatal = await bridge.waitFor((line) => line.type === "bridge" && line.state === "fatal");
  assert.deepEqual(fatal, {
    type: "bridge",
    state: "fatal",
    reason: "bad_url",
    message: "server URL must start with ws:// or wss://: http://127.0.0.1:4317/ws",
  });
  assert.equal(await bridge.exited, 2);
});

test("enriches final/history code safely and preserves streamed whitespace", async (t) => {
  const code = 'const x = "<script>alert(1)</script>";\n  console.log(x);';
  const text = `Intro\n\n\`\`\`typescript\n${code}\n\`\`\`\nAfter\n\`\`\`unknown-language\n<img src=x onerror=alert(1)>\n\`\`\``;
  const daemon = await fakeDaemon(conn => conn.socket.once("message", () => {
    for (const message of [
      {type:"message_delta", messageId:"a", delta:text},
      {type:"reasoning_delta", messageId:"a", delta:"Checking"},
      {type:"message_done", messageId:"a", text:text.replace(/\s+/g, " "), reasoning:"Checked"},
      {type:"message_delta", messageId:"changed", delta:"Old draft"},
      {type:"message_done", messageId:"changed", text:"Changed response"},
      {type:"history", messages:[{id:"a",role:"assistant",text:text.replace(/\s+/g, " ")}, {id:"p",role:"assistant",text:"Plain <b>prose</b>"}, {id:"u",role:"user",text:"unchanged"}]},
    ]) conn.socket.send(JSON.stringify(message));
  }));
  t.after(daemon.close);
  const bridge = runBridge(["--url", daemon.url, "--token-file", await tokenFile()]);
  t.after(() => bridge.child.kill());
  const history = await bridge.waitFor(line => line.type === "history");
  const done = bridge.lines.find(line => line.type === "message_done");
  assert.equal(done.text, text);
  assert.equal(done.reasoning, "Checked");
  assert.deepEqual(bridge.lines.find(line => line.type === "message_delta"), {type:"message_delta",messageId:"a",delta:text});
  assert.deepEqual(bridge.lines.find(line => line.type === "reasoning_delta"), {type:"reasoning_delta",messageId:"a",delta:"Checking"});
  assert.deepEqual(done.segments, history.messages[0].segments);
  assert.equal(history.messages[0].text, text);
  const changed = bridge.lines.find(line => line.type === "message_done" && line.messageId === "changed");
  assert.equal(changed.text, "Changed response");
  assert.deepEqual(changed.segments, [{type:"md",text:"Changed response"}]);
  assert.deepEqual(done.segments.map(s => s.type), ["md","code","md","code"]);
  assert.equal(done.segments[1].code, code);
  assert.equal(done.segments[1].lang, "typescript");
  assert.match(done.segments[1].html, /<span style="color:#[a-fA-F0-9]{6}">/);
  for (const segment of done.segments.filter(s => s.type === "code")) {
    assert.doesNotMatch(segment.html, /class=|<script|<img/);
    assert.match(segment.html, /&lt;/);
  }
  assert.deepEqual(history.messages[1].segments, [{type:"md",text:"Plain <b>prose</b>"}]);
  assert.equal(history.messages[2].text, "unchanged");
  assert.equal(bridge.stderr(), "");
});

test("adds a per-tool view to live, history and earlier activities, keeping the raw fields", async (t) => {
  const shell = { id: "s", kind: "run", title: "Ran a command", status: "done", tool: "bash", source: "shell",
    detail: '{"command":"ls -d ~/x","timeout":30}', output: "\u001b[32mx\u001b[0m\n" };
  const memory = { id: "m", kind: "memory", title: "Checked my notes", status: "done", tool: "mem_search", source: "engram",
    detail: '{"query":"gentle"}', output: '[{"title":"One","type":"bugfix","project":"p"},{"title":"Tw' };
  const old = { id: "o", kind: "read", title: "Read a file", status: "done" };
  const daemon = await fakeDaemon((conn) => conn.socket.once("message", () => {
    conn.socket.send(JSON.stringify({ type: "activity", messageId: "a", activity: shell }));
    conn.socket.send(JSON.stringify({ type: "earlier", before: "a", hasEarlier: true, messages: [{ id: "e", role: "assistant", text: "Earlier", activities: [memory] }] }));
    conn.socket.send(JSON.stringify({ type: "history", messages: [{ id: "u", role: "user", text: "hi" }, { id: "a", role: "assistant", text: "Done", activities: [shell, memory, old] }] }));
  }));
  t.after(daemon.close);
  const bridge = runBridge(["--url", daemon.url, "--token-file", await tokenFile()]);
  t.after(() => bridge.child.kill());
  const history = await bridge.waitFor((line) => line.type === "history");
  const live = bridge.lines.find((line) => line.type === "activity");
  const earlier = bridge.lines.find((line) => line.type === "earlier");
  const { view: liveView, ...liveRaw } = live.activity;
  assert.deepEqual(liveRaw, shell);
  assert.equal(liveView.detail.type, "code");
  assert.equal(liveView.detail.code, "ls -d ~/x");
  assert.match(liveView.detail.html, /<span style="color:#[a-fA-F0-9]{6}">/);
  assert.deepEqual(liveView.detail.extra, [{ key: "timeout", value: "30" }]);
  assert.deepEqual(liveView.output, { type: "terminal", text: "x" });
  const [historyShell, historyMemory, historyOld] = history.messages[1].activities;
  assert.deepEqual(historyShell, live.activity);
  assert.deepEqual(historyMemory.view.detail, { type: "fields", items: [{ key: "query", value: "gentle" }] });
  assert.deepEqual(historyMemory.view.output, { type: "list", items: [{ title: "One", meta: "bugfix · p" }], more: 1, cut: true });
  assert.equal(historyMemory.output, memory.output);
  assert.deepEqual(historyOld, { ...old, view: { detail: null, output: null } });
  assert.equal(history.messages[0].activities, undefined);
  assert.deepEqual(earlier.messages[0].activities[0], historyMemory);
  assert.equal(earlier.messages[0].text, "Earlier");
  assert.equal(bridge.stderr(), "");
});

// `omarchy plugin add` only clones the repository: the bridge must run with no node_modules.
// The copy holds every file git would publish (tracked or new, not ignored), outside the repo.
test("runs from a clean copy without node_modules and still highlights code", async (t) => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const copy = await mkdtemp(join(tmpdir(), "gd-clean-clone-"));
  t.after(() => rm(copy, { recursive: true, force: true }));
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" });
  for (const file of listed.split("\0").filter(Boolean)) {
    if (!existsSync(join(repo, file))) continue;
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    copyFileSync(join(repo, file), join(copy, file));
  }
  assert.equal(existsSync(join(copy, "node_modules")), false);
  const text = "```bash\necho \"$HOME\" # hi\n```\n```\nconst answer = 42;\n```";
  const daemon = await fakeDaemon((conn) => conn.socket.once("message", () => {
    conn.socket.send(JSON.stringify({ type: "ready", seq: 1, agentState: "idle" }));
    conn.socket.send(JSON.stringify({ type: "message_done", messageId: "m", text }));
  }));
  t.after(daemon.close);
  const bridge = runBridge(["--url", daemon.url, "--token-file", await tokenFile()], {}, join(copy, "bridge", "bridge.mjs"));
  t.after(() => bridge.child.kill());
  const died = bridge.exited.then((code) => { throw new Error(`bridge exited ${code}: ${bridge.stderr()}`); });
  await Promise.race([bridge.waitFor((line) => line.type === "ready"), died]);
  const done = await Promise.race([bridge.waitFor((line) => line.type === "message_done"), died]);
  died.catch(() => {});
  assert.deepEqual(done.segments.map((s) => [s.type, s.lang]), [["code", "bash"], ["code", ""]]);
  assert.match(done.segments[0].html, /<span style="color:#[a-fA-F0-9]{6}">/);
  assert.match(done.segments[0].html, /&quot;/);
  assert.equal(done.segments[1].html, "const answer = 42;");
  assert.equal(bridge.stderr(), "");
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

async function files(entries) {
  const dir = await mkdtemp(join(tmpdir(), "gd-files-"));
  const paths = [];
  for (const [name, content] of entries) {
    const path = join(dir, name);
    await writeFile(path, content);
    paths.push(path);
  }
  return paths;
}

const stored = (record, count) => {
  const name = `stored-${count}-${decodeURIComponent(record.headers["x-file-name"])}`;
  return { status: 200, body: { uploadId: record.headers["x-upload-id"] || "u_first000000000000", name, size: record.body.length, mime: "image/png", path: `uploads/u_first000000000000/${name}` } };
};

test("inspects local files for the attachment chips without needing a connection", async (t) => {
  const [image, text] = await files([["shot.png", PNG], ["notes.txt", "hello"]]);
  const bridge = runBridge(["--url", "ws://127.0.0.1:9/ws", "--token-file", await tokenFile()]);
  t.after(() => bridge.child.kill());

  await bridge.waitFor((line) => line.type === "bridge" && line.state === "reconnecting");
  bridge.send({ type: "inspect_files", requestId: "i1", paths: [image, text, "/nonexistent/x.bin", tmpdir()] });
  const inspected = await bridge.waitFor((line) => line.type === "files_inspected");
  assert.deepEqual(inspected, {
    type: "files_inspected",
    requestId: "i1",
    files: [
      { path: image, name: "shot.png", size: PNG.length, mime: "image/png" },
      { path: text, name: "notes.txt", size: 5, mime: "text/plain" },
      { path: "/nonexistent/x.bin", name: "x.bin", error: "file not found" },
      { path: tmpdir(), name: tmpdir().split("/").pop(), error: "not a regular file" },
    ],
  });
});

test("uploads each file with the token, chains the upload id, then sends the message with its attachments", async (t) => {
  const daemon = await fakeDaemon(null, { upload: stored });
  t.after(daemon.close);
  const [first, second] = await files([["my photo ñ.png", PNG], ["notes.txt", "some notes"]]);
  const bridge = runBridge(["--url", daemon.url, "--token-file", await tokenFile()]);
  t.after(() => bridge.child.kill());

  await bridge.waitFor((line) => line.type === "bridge" && line.state === "open");
  bridge.send({ type: "upload_files", requestId: "r1", text: "look", paths: [first, second] });
  const done = await bridge.waitFor((line) => line.type === "upload_done");
  await until(() => daemon.connections[0].frames.length === 2);

  assert.equal(daemon.uploads.length, 2);
  const [one, two] = daemon.uploads;
  for (const record of [one, two]) {
    assert.equal(record.method, "POST");
    assert.equal(record.url, "/upload");
    assert.equal(record.headers.authorization, "Bearer secret-token");
    assert.equal(record.headers.origin, undefined);
  }
  assert.equal(one.headers["x-file-name"], encodeURIComponent("my photo ñ.png"));
  assert.equal(one.headers["x-upload-id"], undefined);
  assert.equal(two.headers["x-upload-id"], "u_first000000000000");
  assert.deepEqual(one.body, PNG);
  assert.equal(String(two.body), "some notes");
  assert.equal(one.headers["content-length"], String(PNG.length));

  const progress = bridge.lines.filter((line) => line.type === "upload_progress");
  assert.deepEqual(progress.at(-1), { type: "upload_progress", requestId: "r1", index: 1, count: 2, name: "notes.txt", loaded: 10, total: 10 });
  assert.deepEqual(done, {
    type: "upload_done",
    requestId: "r1",
    files: [
      { path: first, uploadId: "u_first000000000000", name: "stored-1-my photo ñ.png", size: PNG.length, mime: "image/png" },
      { path: second, uploadId: "u_first000000000000", name: "stored-2-notes.txt", size: 10, mime: "image/png" },
    ],
  });
  assert.deepEqual(daemon.connections[0].frames[1], {
    type: "send",
    text: "look",
    requestId: "r1",
    attachments: [
      { uploadId: "u_first000000000000", name: "stored-1-my photo ñ.png" },
      { uploadId: "u_first000000000000", name: "stored-2-notes.txt" },
    ],
  });
  assert.equal(bridge.stderr(), "");
});

test("a message with files may have no text", async (t) => {
  const daemon = await fakeDaemon(null, { upload: stored });
  t.after(daemon.close);
  const [image] = await files([["a.png", PNG]]);
  const bridge = runBridge(["--url", daemon.url, "--token-file", await tokenFile()]);
  t.after(() => bridge.child.kill());

  await bridge.waitFor((line) => line.type === "bridge" && line.state === "open");
  bridge.send({ type: "upload_files", requestId: "r2", text: "", paths: [image] });
  await until(() => daemon.connections[0].frames.length === 2);
  assert.deepEqual(daemon.connections[0].frames[1], {
    type: "send", text: "", requestId: "r2", attachments: [{ uploadId: "u_first000000000000", name: "stored-1-a.png" }],
  });
});

for (const [label, upload, expected] of [
  ["a rejected token (401)", () => ({ status: 401, body: { code: "unauthorized", message: "The access key is not valid." } }),
    { index: 0, name: "a.png", status: 401, code: "unauthorized", message: "Could not upload a.png: The access key is not valid." }],
  ["a file the daemon refuses as too large (413)", (record, count) => count === 1 ? stored(record, count)
    : { status: 413, body: { code: "file_too_large", message: "This file is too large: up to 25 MB per file." } },
    { index: 1, name: "b.txt", status: 413, code: "file_too_large", message: "Could not upload b.txt: This file is too large: up to 25 MB per file." }],
  ["a 413 without a JSON answer", () => ({ status: 413, body: "<html>too big</html>" }),
    { index: 0, name: "a.png", status: 413, code: "too_large", message: "Could not upload a.png: the daemon refused it as too large (HTTP 413)." }],
  ["a dropped connection", () => ({ destroy: true }),
    { index: 0, name: "a.png", code: "network" }],
]) {
  test(`reports ${label} as upload_error and sends nothing`, async (t) => {
    const daemon = await fakeDaemon(null, { upload });
    t.after(daemon.close);
    const paths = await files([["a.png", PNG], ["b.txt", "bee"]]);
    const bridge = runBridge(["--url", daemon.url, "--token-file", await tokenFile()]);
    t.after(() => bridge.child.kill());

    await bridge.waitFor((line) => line.type === "bridge" && line.state === "open");
    bridge.send({ type: "upload_files", requestId: "r3", text: "hi", paths });
    const error = await bridge.waitFor((line) => line.type === "upload_error");
    const { message, ...rest } = error;
    const { message: expectedMessage, ...expectedRest } = expected;
    assert.deepEqual(rest, { type: "upload_error", requestId: "r3", ...expectedRest });
    if (expectedMessage) assert.equal(message, expectedMessage);
    else assert.match(message, /^Could not upload a\.png: /);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(daemon.connections[0].frames.length, 1);
    assert.equal(bridge.lines.some((line) => line.type === "upload_done"), false);
  });
}

test("refuses to upload while the daemon is not connected", async (t) => {
  const [image] = await files([["a.png", PNG]]);
  const bridge = runBridge(["--url", "ws://127.0.0.1:9/ws", "--token-file", await tokenFile()]);
  t.after(() => bridge.child.kill());

  await bridge.waitFor((line) => line.type === "bridge" && line.state === "reconnecting");
  bridge.send({ type: "upload_files", requestId: "r4", text: "", paths: [image] });
  const error = await bridge.waitFor((line) => line.type === "upload_error");
  assert.deepEqual(error, { type: "upload_error", requestId: "r4", code: "not_connected", message: "Not connected to the Gentle Dot daemon: the files were not sent." });
});

// --- fetch_attachment (S14.5 with the S14.7 daemon contract) ---------------------------------

const UPLOAD_ID = "u_AbCdEfGhIjKlMnOpQr-_12";
const CAP = 25 * 1024 * 1024;

async function runtimeDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "gd-runtime-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const cacheDir = (runtime, uploadId = UPLOAD_ID) => join(runtime, "omarchy-gentle-dot", "cache", uploadId);
const serve = (body, type = "image/png", delayMs = 0) => (record, res) => setTimeout(() => {
  res.writeHead(200, { "Content-Type": type, "Content-Length": body.length });
  res.end(body);
}, delayMs);
const refuse = (status) => (record, res) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: "x", message: "no" }));
};

async function fetchingBridge(t, download, token = "secret-token\n") {
  const daemon = await fakeDaemon(null, { download });
  t.after(daemon.close);
  const runtime = await runtimeDir(t);
  const bridge = runBridge(["--url", daemon.url, "--token-file", await tokenFile(token)], { XDG_RUNTIME_DIR: runtime });
  t.after(() => bridge.child.kill());
  await bridge.waitFor((line) => line.type === "bridge" && line.state === "open");
  return { daemon, runtime, bridge };
}

const replyTo = (bridge, requestId) => bridge.waitFor((line) => line.requestId === requestId
  && (line.type === "attachment_cached" || line.type === "attachment_error"), 8000);

test("fetch_attachment downloads a stored file with the token into a private cache and says where", async (t) => {
  const name = "my photo #1 ñ (2).png";
  const { daemon, runtime, bridge } = await fetchingBridge(t, serve(PNG));

  bridge.send({ type: "fetch_attachment", requestId: "f1", uploadId: UPLOAD_ID, name });
  const cached = await replyTo(bridge, "f1");
  const path = join(cacheDir(runtime), name);
  assert.deepEqual(cached, { type: "attachment_cached", requestId: "f1", uploadId: UPLOAD_ID, name, path, mime: "image/png" });
  assert.equal(daemon.uploads.length, 1);
  const [request] = daemon.uploads;
  assert.equal(request.method, "GET");
  assert.equal(request.url, `/upload/${UPLOAD_ID}/${encodeURIComponent(name)}`);
  assert.equal(request.headers.authorization, "Bearer secret-token");
  assert.equal(request.headers.origin, undefined);
  assert.deepEqual(await readFile(path), PNG);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  for (const dir of [cacheDir(runtime), join(runtime, "omarchy-gentle-dot", "cache"), join(runtime, "omarchy-gentle-dot")]) {
    assert.equal((await stat(dir)).mode & 0o777, 0o700, dir);
  }
  assert.deepEqual(await readdir(cacheDir(runtime)), [name]);
  assert.doesNotMatch(JSON.stringify(bridge.lines), /secret-token/);
  assert.equal(bridge.stderr(), "");
});

test("fetch_attachment reuses a cached copy and sends one request for concurrent asks of the same file", async (t) => {
  const { daemon, runtime, bridge } = await fetchingBridge(t, serve(Buffer.from("plain notes"), "application/octet-stream", 150));

  for (const requestId of ["a", "b"]) bridge.send({ type: "fetch_attachment", requestId, uploadId: UPLOAD_ID, name: "notes.txt" });
  const [first, second] = [await replyTo(bridge, "a"), await replyTo(bridge, "b")];
  const path = join(cacheDir(runtime), "notes.txt");
  for (const [reply, requestId] of [[first, "a"], [second, "b"]]) {
    assert.deepEqual(reply, { type: "attachment_cached", requestId, uploadId: UPLOAD_ID, name: "notes.txt", path, mime: "text/plain" });
  }
  assert.equal(daemon.uploads.length, 1);

  bridge.send({ type: "fetch_attachment", requestId: "c", uploadId: UPLOAD_ID, name: "notes.txt" });
  assert.equal((await replyTo(bridge, "c")).path, path);
  assert.equal(daemon.uploads.length, 1);
  assert.equal(String(await readFile(path)), "plain notes");
});

for (const [label, download, code] of [
  ["a rejected token (401)", refuse(401), "unauthorized"],
  ["a file the daemon does not have (404)", refuse(404), "not_found"],
  ["a daemon without downloads (405)", refuse(405), "unsupported"],
  ["a declared Content-Length over the 25 MB cap", (record, res) => {
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": CAP + 1 });
    res.write(PNG);
  }, "too_large"],
  ["a body streamed past the 25 MB cap", (record, res) => {
    res.writeHead(200, { "Content-Type": "image/png" });
    const chunk = Buffer.alloc(1024 * 1024, 7);
    let sent = 0;
    const more = () => {
      while (sent < 26) {
        sent++;
        if (!res.write(chunk)) { res.once("drain", more); return; }
      }
      res.end();
    };
    more();
  }, "too_large"],
  ["a dropped connection", (record, res, req) => req.socket.destroy(), "network"],
]) {
  test(`fetch_attachment reports ${label} as ${code} and leaves nothing in the cache`, async (t) => {
    const { daemon, runtime, bridge } = await fetchingBridge(t, download);

    bridge.send({ type: "fetch_attachment", requestId: "e1", uploadId: UPLOAD_ID, name: "shot.png" });
    const error = await replyTo(bridge, "e1");
    assert.deepEqual(error, { type: "attachment_error", requestId: "e1", uploadId: UPLOAD_ID, name: "shot.png", code });
    assert.equal(daemon.uploads.length, 1);
    const left = await readdir(cacheDir(runtime)).catch(() => []);
    assert.deepEqual(left, []);
    assert.doesNotMatch(JSON.stringify(bridge.lines), /secret-token/);
  });
}

test("fetch_attachment refuses a bad upload id or name before any request or cache path", async (t) => {
  const { daemon, runtime, bridge } = await fetchingBridge(t, serve(PNG));
  const bad = [
    ["u_short", "a.png"], ["../u_AbCdEfGhIjKlMnOpQr-_12", "a.png"], [`${UPLOAD_ID}/x`, "a.png"], ["x_AbCdEfGhIjKlMnOpQr-_12", "a.png"],
    [UPLOAD_ID, "a/b.png"], [UPLOAD_ID, "a\\b.png"], [UPLOAD_ID, "a\u0000b.png"], [UPLOAD_ID, ".."], [UPLOAD_ID, "."],
    [UPLOAD_ID, ".hidden.png"], [UPLOAD_ID, ""], [UPLOAD_ID, "line\nbreak.png"], [UPLOAD_ID, 7], [null, "a.png"],
  ];
  for (const [index, [uploadId, name]] of bad.entries()) {
    bridge.send({ type: "fetch_attachment", requestId: `bad-${index}`, uploadId, name });
    const error = await replyTo(bridge, `bad-${index}`);
    assert.equal(error.type, "attachment_error", JSON.stringify([uploadId, name]));
    assert.equal(error.code, "unsupported", JSON.stringify([uploadId, name]));
  }
  bridge.send({ type: "fetch_attachment", uploadId: UPLOAD_ID, name: "a.png" });
  assert.deepEqual(await bridge.waitFor((line) => line.type === "bridge_error"),
    { type: "bridge_error", code: "bad_input", message: "fetch_attachment needs a requestId" });
  assert.equal(daemon.uploads.length, 0);
  assert.deepEqual(await readdir(runtime), []);
});

test("exits 0 when stdin closes", async (t) => {
  const daemon = await fakeDaemon();
  t.after(daemon.close);
  const bridge = runBridge(["--url", daemon.url, "--token-file", await tokenFile()]);

  await bridge.waitFor((line) => line.type === "bridge" && line.state === "open");
  bridge.child.stdin.end();
  assert.equal(await bridge.exited, 0);
});
