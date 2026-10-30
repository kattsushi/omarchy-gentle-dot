#!/usr/bin/env node
// Shows one desktop notification through org.freedesktop.Notifications on the session bus and
// waits for it, like `notify-send --wait`, but with its text read from stdin: a notification's
// summary and body (reply excerpts, ask titles) never appear in a command line or environment
// that other local accounts could read (S22.2). Notifier.qml runs it once per notification.
//
//   node notify.mjs   < {"appName","summary","body","actions":["default","Open"],"expireMs":8000}
//
// stdout: the action key ("default") when the notification service reports a click on this
//         notification, then it exits. It also exits, silently, when the notification closes or
//         its expiry time has passed. Exit 1 on a bad payload or bus error (stderr, no text).
import { createInterface } from "node:readline";
import { MESSAGE, openBus } from "./dbus.mjs";

const SERVICE = "org.freedesktop.Notifications";
const PATH = "/org/freedesktop/Notifications";

function fail(message) {
  process.stderr.write(`notify: ${message}\n`);
  process.exit(1);
}

function readPayload() {
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      lines.close();
      resolve(value);
    };
    lines.once("line", (line) => {
      try {
        finish(JSON.parse(line));
      } catch {
        finish(null);
      }
    });
    lines.once("close", () => finish(null));
  });
}

const text = (value) => (typeof value === "string" ? value : "");

async function main() {
  const payload = await readPayload();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("bad payload: one JSON object expected on stdin");
  const actions = Array.isArray(payload.actions) ? payload.actions.filter((action) => typeof action === "string") : [];
  const expireMs = Number.isInteger(payload.expireMs) ? payload.expireMs : -1;

  let bus;
  try {
    bus = await openBus();
  } catch (error) {
    fail(`cannot reach the session bus (${error.code || error.message})`);
  }
  bus.on("error", (error) => fail(`session bus error (${error.message})`));
  bus.on("close", () => process.exit(0));

  // The bus delivers each sender's messages in order, so the service's signals about this
  // notification come after its answer to Notify: anything earlier is about another one, or
  // forged, and is dropped (nothing is buffered).
  let id = null;
  let service = null;
  const handle = (message) => {
    if (message.type !== MESSAGE.signal || message.interface !== SERVICE || message.path !== PATH) return;
    if (id === null) return;
    // Only the service that showed the notification speaks for it.
    if (message.sender !== service || message.body[0] !== id) return;
    if (message.member === "ActionInvoked" && typeof message.body[1] === "string") {
      process.stdout.write(`${message.body[1]}\n`, () => process.exit(0));
    } else if (message.member === "NotificationClosed") process.exit(0);
  };
  bus.on("message", handle);

  const match = (member) => bus.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus",
    interface: "org.freedesktop.DBus", member: "AddMatch", signature: "s",
    body: [`type='signal',interface='${SERVICE}',path='${PATH}',member='${member}'`] });
  let reply;
  try {
    await match("ActionInvoked");
    await match("NotificationClosed");
    reply = await bus.callMessage({ destination: SERVICE, path: PATH, interface: SERVICE, member: "Notify",
      signature: "susssasa{sv}i",
      body: [text(payload.appName), 0, "", text(payload.summary), text(payload.body), actions, {}, expireMs] });
  } catch (error) {
    fail(error.name === "org.freedesktop.DBus.Error.ServiceUnknown"
      ? "no notification service on the session bus (org.freedesktop.DBus.Error.ServiceUnknown)"
      : `the notification was not shown (${error.name || error.message})`);
  }
  [id] = reply.body;
  service = reply.sender;
  // Like notify-send --wait: done once the notification has expired.
  if (expireMs > 0) setTimeout(() => process.exit(0), expireMs + 500);
}

main();
