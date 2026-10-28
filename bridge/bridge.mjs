#!/usr/bin/env node
// Relays one Gentle Dot daemon WebSocket (protocol v1) over stdio as newline-delimited JSON,
// so a QML Process can talk to a local or remote daemon without QtWebSockets.
//
//   node bridge.mjs --url ws://127.0.0.1:4317/ws --token-file ~/.gentle-dot/token
//
// stdin:  one client message per line (send, abort, ui_response, get_history, ...), sent as is.
//         The bridge says hello itself, with the token read from --token-file on every connect.
// stdout: one daemon message per line, with final/history assistant segments (render.mjs),
//         raw text retained (stream whitespace preferred for old daemons), `at` on live
//         user_message/message_done and on history the bridge has seen before when the daemon
//         sends none (times.mjs, kept in $XDG_STATE_HOME/omarchy-gentle-dot), plus bridge lines:
//         {"type":"bridge","state":"connecting"|"open"|"reconnecting"|"fatal", ...}
//         {"type":"bridge_error","code":"bad_input"|"not_connected"|"message_times","message":...}
// Bridge-local stdin commands (never forwarded as is):
//   {"type":"inspect_files","requestId","paths":[...]} -> {"type":"files_inspected","requestId",
//     "files":[{path,name,size,mime} | {path,name,error}]} (works without a connection)
//   {"type":"upload_files","requestId","text","paths":[...]} -> POST <http(s) origin of --url>/upload
//     per file (token from --token-file as a Bearer header, X-File-Name, X-Upload-Id of the first
//     file for the rest), {"type":"upload_progress","requestId","index","count","name","loaded","total"},
//     then {"type":"upload_done","requestId","files":[{path,uploadId,name,size,mime}]} and the daemon
//     gets {"type":"send","text","requestId","attachments":[{uploadId,name}]}; or one
//     {"type":"upload_error","requestId","code","message"[,"index","name","status"]} and nothing is sent.
//   {"type":"fetch_attachment","requestId","uploadId","name"} -> GET <http(s) origin of --url>/upload/
//     <uploadId>/<encoded name> (patched daemons, S14.7) with the same Bearer token, into the private cache
//     $XDG_RUNTIME_DIR/omarchy-gentle-dot/cache/<uploadId>/<name> (folders 0700, file 0600, at most the
//     daemon's 25 MB per file, written to a .part file and renamed). A cached copy is reused and
//     concurrent asks share one download. Answers {"type":"attachment_cached","requestId","uploadId",
//     "name","path","mime"} (mime from the first bytes, as for local files) or {"type":"attachment_error",
//     "requestId","uploadId","name","code":"unauthorized"|"not_found"|"too_large"|"network"|"unsupported"}.
//     A bad id or name is refused (unsupported) before any request or path is made.
// Exit codes: 0 when stdin closes, 2 on a fatal error (bad URL, unreadable token, rejected token
// or protocol); anything else is retried with backoff.
import {
  closeSync, createReadStream, createWriteStream, lstatSync, openSync, readFileSync, readSync, renameSync, statSync,
  unlinkSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ATTACHMENT_LIMITS, downloadUrl, mimeFor, uploadEndpoint, validStoredName, validUploadId } from "./attachments.mjs";
import { privateDir } from "./private-dir.mjs";
import { renderer } from "./render.mjs";
import { messageTimes, openTimeStore, timesFile } from "./times.mjs";

const PROTOCOL = 1;
const BACKOFF_MS = [500, 1000, 2000, 5000];
const FATAL_CLOSE = new Map([
  [4401, "unauthorized"],
  [4400, "bad_protocol"],
]);

function parseArgs(argv) {
  const options = {
    url: process.env.GENTLE_DOT_URL || "ws://127.0.0.1:4317/ws",
    tokenFile: process.env.GENTLE_DOT_TOKEN_FILE || "~/.gentle-dot/token",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url") options.url = argv[++i];
    else if (argv[i] === "--token-file") options.tokenFile = argv[++i];
  }
  return options;
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fatal(fields) {
  emit({ type: "bridge", state: "fatal", ...fields });
  process.exitCode = 2;
  // Let stdout drain before leaving.
  process.stdout.write("", () => process.exit(2));
}

function expandHome(path) {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

function readToken(path) {
  try {
    return readFileSync(expandHome(path), "utf8").trim();
  } catch {
    return null;
  }
}

const UPLOAD_TIMEOUT_MS = 60000;

// Size and type of a local file for its attachment chip; nothing leaves the machine.
function inspectFile(path) {
  const name = basename(path);
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    return { path, name, error: error.code === "ENOENT" ? "file not found" : "cannot read it" };
  }
  if (!stats.isFile()) return { path, name, error: "not a regular file" };
  try {
    const fd = openSync(path, "r");
    const head = Buffer.alloc(16);
    const read = readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    return { path, name, size: stats.size, mime: mimeFor(name, head.subarray(0, read)) };
  } catch {
    return { path, name, error: "cannot read it" };
  }
}

function uploadRefusal(name, status, body) {
  const code = typeof body?.code === "string" ? body.code
    : status === 401 ? "unauthorized" : status === 413 ? "too_large" : "http_error";
  const reason = typeof body?.message === "string" ? body.message
    : status === 401 ? "the daemon rejected the token (HTTP 401)."
    : status === 413 ? "the daemon refused it as too large (HTTP 413)."
    : `the daemon answered HTTP ${status}.`;
  return { ok: false, status, code, message: `Could not upload ${name}: ${reason}` };
}

// POST /upload with the raw bytes, as the daemon expects. No Origin header: the daemon only
// checks Origin when one is sent (browsers), like the WebSocket.
function uploadOne(endpoint, token, path, uploadId, onProgress) {
  return new Promise((resolve) => {
    const name = basename(path);
    let size;
    try {
      const stats = statSync(path);
      if (!stats.isFile()) throw new Error("not a regular file");
      size = stats.size;
    } catch {
      resolve({ ok: false, code: "unreadable", message: `Could not upload ${name}: cannot read the file.` });
      return;
    }
    const target = new URL(endpoint);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Content-Length": size,
      "X-File-Name": encodeURIComponent(name),
    };
    if (uploadId) headers["X-Upload-Id"] = uploadId;
    let settled = false;
    let status = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: "POST", headers });
    request.setTimeout(UPLOAD_TIMEOUT_MS, () => request.destroy(new Error(`no answer within ${UPLOAD_TIMEOUT_MS / 1000} s`)));
    request.on("response", (response) => {
      status = response.statusCode;
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = null;
        }
        if (status === 200 && typeof body?.uploadId === "string" && typeof body?.name === "string") finish({ ok: true, file: body });
        else if (status === 200) finish({ ok: false, status, code: "bad_answer", message: `Could not upload ${name}: the daemon's answer was not understood.` });
        else finish(uploadRefusal(name, status, body));
      });
      response.on("error", () => finish(uploadRefusal(name, status, null)));
    });
    // A daemon that refuses early (401, 413) closes the connection while the body is still
    // being written; its answer, already received, wins over the write error.
    request.on("error", (error) => {
      if (!status) finish({ ok: false, code: "network", message: `Could not upload ${name}: ${error.message}` });
    });
    const body = createReadStream(path);
    let loaded = 0;
    let reported = -1;
    onProgress(0, size);
    body.on("data", (chunk) => {
      loaded += chunk.length;
      const tenth = size ? Math.floor((loaded / size) * 10) : 10;
      if (tenth !== reported || loaded === size) {
        reported = tenth;
        onProgress(loaded, size);
      }
    });
    body.on("error", (error) => request.destroy(error));
    body.pipe(request);
  });
}

const FETCH_TIMEOUT_MS = 60000;

class TooLarge extends Error {}

function cacheFolder(uploadId) {
  const base = privateDir(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "omarchy-gentle-dot"));
  return privateDir(join(privateDir(join(base, "cache")), uploadId));
}

// A complete cached copy: one of our regular files (never a link); its type from its first bytes.
function cachedCopy(path, name) {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.uid !== process.getuid()) return null;
    const fd = openSync(path, "r");
    const head = Buffer.alloc(16);
    const read = readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    return { path, mime: mimeFor(name, head.subarray(0, read)) };
  } catch {
    return null;
  }
}

function removeQuietly(path) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

const DOWNLOAD_REFUSALS = new Map([[401, "unauthorized"], [403, "unauthorized"], [404, "not_found"], [405, "unsupported"], [413, "too_large"]]);

// GET one stored file into the cache: {path, mime} or {code}. The body goes to a private .part file,
// counted against the per-file limit, then renamed into place. No Origin header, like the upload.
function downloadOne(address, token, uploadId, name) {
  return new Promise((resolve) => {
    const target = new URL(address);
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    request.setTimeout(FETCH_TIMEOUT_MS, () => request.destroy(new Error("timed out")));
    request.on("error", () => finish({ code: "network" }));
    request.on("response", async (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish({ code: DOWNLOAD_REFUSALS.get(response.statusCode) || "network" });
        return;
      }
      const limit = ATTACHMENT_LIMITS.fileBytes;
      if (Number(response.headers["content-length"]) > limit) {
        finish({ code: "too_large" });
        request.destroy();
        return;
      }
      let folder;
      try {
        folder = cacheFolder(uploadId);
      } catch {
        finish({ code: "unsupported" });
        request.destroy();
        return;
      }
      const path = join(folder, name);
      const part = join(folder, `.part-${randomBytes(6).toString("hex")}`);
      let received = 0;
      const counter = new Transform({
        transform(chunk, encoding, done) {
          received += chunk.length;
          done(received > limit ? new TooLarge() : null, chunk);
        },
      });
      try {
        await pipeline(response, counter, createWriteStream(part, { flags: "wx", mode: 0o600 }));
        renameSync(part, path);
        finish(cachedCopy(path, name) || { code: "network" });
      } catch (error) {
        removeQuietly(part);
        request.destroy();
        finish({ code: error instanceof TooLarge ? "too_large" : "network" });
      }
    });
    request.end();
  });
}

function main() {
  const { url, tokenFile } = parseArgs(process.argv.slice(2));
  if (!/^wss?:\/\//.test(url)) {
    fatal({ reason: "bad_url", message: `server URL must start with ws:// or wss://: ${url}` });
    return;
  }

  // Message times outlive the bridge: written when stdin closes, on exit and on a stop signal.
  const store = openTimeStore(timesFile(), {
    onError: (error) => emit({ type: "bridge_error", code: "message_times", message: `cannot save message times: ${error.message}` }),
  });
  const times = messageTimes(url, store);
  // A message is never held back by its time.
  const stamped = (message) => {
    try {
      return times.relay(message);
    } catch {
      return message;
    }
  };
  process.on("exit", () => store.flush());
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.once(signal, () => {
      store.flush();
      process.kill(process.pid, signal);
    });
  }

  let socket = null;
  let attempt = 0;
  let retryTimer = null;
  let stopped = false;

  const connect = () => {
    const token = readToken(tokenFile);
    if (!token) {
      fatal({ reason: "token_missing", message: `cannot read the token file ${tokenFile}` });
      return;
    }
    emit({ type: "bridge", state: "connecting", url });
    const render = renderer();
    const current = new WebSocket(url);
    socket = current;

    current.addEventListener("open", () => {
      // "reasoning": opt in to model reasoning (reasoning_delta); daemons without capabilities ignore it.
      current.send(JSON.stringify({ type: "hello", token, protocol: PROTOCOL, capabilities: ["reasoning"] }));
      emit({ type: "bridge", state: "open" });
    });

    current.addEventListener("message", (event) => {
      const text = String(event.data);
      try {
        const message = JSON.parse(text);
        if (message && message.type === "ready") attempt = 0;
        emit(stamped(render(message)));
      } catch {
        emit({ type: "bridge_error", code: "bad_daemon_message", message: text.slice(0, 200) });
      }
    });

    current.addEventListener("close", (event) => {
      if (socket === current) socket = null;
      if (stopped) return;
      const reason = FATAL_CLOSE.get(event.code);
      if (reason) {
        stopped = true;
        fatal({ code: event.code, reason });
        return;
      }
      const retryInMs = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt++;
      emit({ type: "bridge", state: "reconnecting", code: event.code, retryInMs });
      retryTimer = setTimeout(connect, retryInMs);
    });

    // A failed connection also fires "close", which schedules the retry.
    current.addEventListener("error", () => {});
  };

  const uploadFiles = async ({ requestId, text, paths }) => {
    const fail = (fields) => emit({ type: "upload_error", requestId, ...fields });
    const connected = () => socket && socket.readyState === WebSocket.OPEN;
    if (!connected()) {
      fail({ code: "not_connected", message: "Not connected to the Gentle Dot daemon: the files were not sent." });
      return;
    }
    const token = readToken(tokenFile);
    if (!token) {
      fail({ code: "token_missing", message: `Cannot read the token file ${tokenFile}: the files were not sent.` });
      return;
    }
    const endpoint = uploadEndpoint(url);
    const uploaded = [];
    // The first file's answer names the message folder; the others join it.
    let uploadId = "";
    for (let index = 0; index < paths.length; index++) {
      const name = basename(paths[index]);
      const result = await uploadOne(endpoint, token, paths[index], uploadId, (loaded, total) =>
        emit({ type: "upload_progress", requestId, index, count: paths.length, name, loaded, total }));
      if (!result.ok) {
        const { ok, ...fields } = result;
        fail({ index, name, ...fields });
        return;
      }
      uploadId ||= result.file.uploadId;
      const { uploadId: id, name: stored, size, mime } = result.file;
      uploaded.push({ path: paths[index], uploadId: id, name: stored, size, mime });
    }
    if (!connected()) {
      fail({ code: "not_connected", message: "The connection dropped after the upload: the message was not sent." });
      return;
    }
    emit({ type: "upload_done", requestId, files: uploaded });
    socket.send(JSON.stringify({ type: "send", text, requestId, attachments: uploaded.map(({ uploadId: id, name }) => ({ uploadId: id, name })) }));
  };

  // "uploadId/name" -> the download in progress, shared by concurrent asks for the same file.
  const downloads = new Map();

  const cacheAttachment = async (uploadId, name) => {
    const address = downloadUrl(url, uploadId, name);
    if (!address) return { code: "unsupported" };
    const cached = cachedCopy(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "omarchy-gentle-dot", "cache", uploadId, name), name);
    if (cached) return cached;
    const token = readToken(tokenFile);
    if (!token) return { code: "unauthorized" };
    return downloadOne(address, token, uploadId, name);
  };

  const fetchAttachment = async ({ requestId, uploadId, name }) => {
    const echo = { requestId };
    if (typeof uploadId === "string") echo.uploadId = uploadId;
    if (typeof name === "string") echo.name = name;
    if (!validUploadId(uploadId) || !validStoredName(name)) {
      emit({ type: "attachment_error", ...echo, code: "unsupported" });
      return;
    }
    const key = `${uploadId}/${name}`;
    let job = downloads.get(key);
    if (!job) {
      job = cacheAttachment(uploadId, name).finally(() => downloads.delete(key));
      downloads.set(key, job);
    }
    const result = await job;
    if (result.path) emit({ type: "attachment_cached", ...echo, path: result.path, mime: result.mime });
    else emit({ type: "attachment_error", ...echo, code: result.code });
  };

  const validPaths = (paths) => Array.isArray(paths) && paths.length > 0
    && paths.every((path) => typeof path === "string" && path.startsWith("/"));

  // Bridge-local commands; false for anything that goes to the daemon as is.
  const local = (message) => {
    if (message.type === "inspect_files") {
      if (!validPaths(message.paths)) emit({ type: "bridge_error", code: "bad_input", message: "inspect_files needs absolute paths" });
      else emit({ type: "files_inspected", requestId: message.requestId, files: message.paths.map(inspectFile) });
      return true;
    }
    if (message.type === "upload_files") {
      if (typeof message.requestId !== "string" || !message.requestId || !validPaths(message.paths)
        || message.paths.length > ATTACHMENT_LIMITS.files || (message.text !== undefined && typeof message.text !== "string")) {
        emit({ type: "bridge_error", code: "bad_input", message: "upload_files needs a requestId, text and 1-10 absolute paths" });
      } else void uploadFiles({ requestId: message.requestId, text: message.text || "", paths: message.paths });
      return true;
    }
    if (message.type === "fetch_attachment") {
      if (typeof message.requestId !== "string" || !message.requestId) {
        emit({ type: "bridge_error", code: "bad_input", message: "fetch_attachment needs a requestId" });
      } else void fetchAttachment(message);
      return true;
    }
    return false;
  };

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      message = null;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      emit({ type: "bridge_error", code: "bad_input", message: "stdin line is not a JSON object" });
      return;
    }
    if (local(message)) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      emit({ type: "bridge_error", code: "not_connected", message: "not connected to the Gentle Dot daemon" });
      return;
    }
    socket.send(JSON.stringify(message));
  });
  lines.on("close", () => {
    stopped = true;
    clearTimeout(retryTimer);
    socket?.close(1000);
    process.exit(0);
  });

  connect();
}

main();
