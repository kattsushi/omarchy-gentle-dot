// A small D-Bus client for the session bus socket: SASL EXTERNAL, the wire format (both byte
// orders read, little-endian written), method calls, replies and signals. Just enough for
// org.freedesktop.Notifications (bridge/notify.mjs), with no dependency and no child process,
// so no notification text ever reaches a command line (S22.2).
import { EventEmitter } from "node:events";
import { connect } from "node:net";

export const MESSAGE = { call: 1, return: 2, error: 3, signal: 4 };
const FIELDS = [
  [1, "path", "o"], [2, "interface", "s"], [3, "member", "s"], [4, "errorName", "s"],
  [5, "replySerial", "u"], [6, "destination", "s"], [7, "sender", "s"], [8, "signature", "g"],
];
const NO_REPLY_EXPECTED = 1;

const ALIGN = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, a: 4, "(": 8, "{": 8, v: 1, h: 4 };

const BASIC = "ybnqiuxtdsogh";

// The end of the complete type starting at `start` in a signature. A struct has at least one
// member; a dict entry ({key value}, only as an array element) exactly two, with a basic key.
function typeEnd(signature, start, inArray = false) {
  const bad = () => new Error(`bad signature ${signature}`);
  const code = signature[start];
  if (code === "a") return typeEnd(signature, start + 1, true);
  if (code === "(" || code === "{") {
    if (code === "{" && (!inArray || !BASIC.includes(signature[start + 1] || "?"))) throw bad();
    const close = code === "(" ? ")" : "}";
    let at = start + 1;
    let count = 0;
    while (signature[at] !== close) {
      if (at >= signature.length) throw bad();
      at = typeEnd(signature, at);
      count++;
    }
    if (count === 0 || (code === "{" && count !== 2)) throw bad();
    return at + 1;
  }
  if (!code || !ALIGN[code] || code === "(" || code === "{") throw bad();
  return start + 1;
}

// "susssasa{sv}i" -> ["s", "u", "s", "s", "s", "as", "a{sv}", "i"]
export function splitSignature(signature) {
  const types = [];
  for (let at = 0; at < signature.length;) {
    const end = typeEnd(signature, at);
    types.push(signature.slice(at, end));
    at = end;
  }
  return types;
}

// Inner types of a struct or dict entry type: "(yv)" -> ["y", "v"].
const members = (type) => splitSignature(type.slice(1, -1));

class Writer {
  constructor() {
    this.buffer = Buffer.alloc(256);
    this.at = 0;
  }

  room(size) {
    if (this.at + size <= this.buffer.length) return;
    const bigger = Buffer.alloc(Math.max(this.buffer.length * 2, this.at + size));
    this.buffer.copy(bigger, 0, 0, this.at);
    this.buffer = bigger;
  }

  align(size) {
    const pad = (size - (this.at % size)) % size;
    this.room(pad);
    this.buffer.fill(0, this.at, this.at + pad);
    this.at += pad;
  }

  number(method, size, value) {
    this.align(size);
    this.room(size);
    this.buffer[method](value, this.at);
    this.at += size;
  }

  bytes(data) {
    this.room(data.length);
    data.copy(this.buffer, this.at);
    this.at += data.length;
  }

  write(type, value) {
    switch (type[0]) {
      case "y": return this.number("writeUInt8", 1, value);
      case "b": return this.number("writeUInt32LE", 4, value ? 1 : 0);
      case "n": return this.number("writeInt16LE", 2, value);
      case "q": return this.number("writeUInt16LE", 2, value);
      case "i": return this.number("writeInt32LE", 4, value);
      case "u": case "h": return this.number("writeUInt32LE", 4, value);
      case "x": return this.number("writeBigInt64LE", 8, BigInt(value));
      case "t": return this.number("writeBigUInt64LE", 8, BigInt(value));
      case "d": return this.number("writeDoubleLE", 8, value);
      case "s": case "o": {
        const data = Buffer.from(String(value), "utf8");
        this.number("writeUInt32LE", 4, data.length);
        this.bytes(Buffer.concat([data, Buffer.alloc(1)]));
        return undefined;
      }
      case "g": {
        const data = Buffer.from(String(value), "ascii");
        this.number("writeUInt8", 1, data.length);
        this.bytes(Buffer.concat([data, Buffer.alloc(1)]));
        return undefined;
      }
      case "v": {
        const [signature, inner] = value;
        this.write("g", signature);
        return this.write(signature, inner);
      }
      case "(": case "{": {
        this.align(8);
        members(type).forEach((member, index) => this.write(member, value[index]));
        return undefined;
      }
      case "a": {
        const element = type.slice(1);
        this.number("writeUInt32LE", 4, 0);
        const lengthAt = this.at - 4;
        this.align(ALIGN[element[0]]);
        const start = this.at;
        // A dictionary may be given as an object: {key: [signature, value]} for a{sv}.
        const items = Array.isArray(value) ? value : Object.entries(value || {});
        for (const item of items) this.write(element, item);
        this.buffer.writeUInt32LE(this.at - start, lengthAt);
        return undefined;
      }
      default:
        throw new Error(`cannot write type ${type}`);
    }
  }

  done() {
    return this.buffer.subarray(0, this.at);
  }
}

class Reader {
  constructor(buffer, littleEndian, at = 0) {
    this.buffer = buffer;
    this.little = littleEndian;
    this.at = at;
  }

  align(size) {
    this.at += (size - (this.at % size)) % size;
  }

  number(name, size) {
    this.align(size);
    if (this.at + size > this.buffer.length) throw new Error("truncated D-Bus message");
    const value = this.buffer[`read${name}${size > 1 ? (this.little ? "LE" : "BE") : ""}`](this.at);
    this.at += size;
    return value;
  }

  text(length, encoding) {
    if (this.at + length + 1 > this.buffer.length) throw new Error("truncated D-Bus message");
    const value = this.buffer.toString(encoding, this.at, this.at + length);
    this.at += length + 1;
    return value;
  }

  read(type) {
    switch (type[0]) {
      case "y": return this.number("UInt8", 1);
      case "b": return this.number("UInt32", 4) !== 0;
      case "n": return this.number("Int16", 2);
      case "q": return this.number("UInt16", 2);
      case "i": return this.number("Int32", 4);
      case "u": case "h": return this.number("UInt32", 4);
      case "x": return this.number("BigInt64", 8);
      case "t": return this.number("BigUInt64", 8);
      case "d": return this.number("Double", 8);
      case "s": case "o": return this.text(this.number("UInt32", 4), "utf8");
      case "g": return this.text(this.number("UInt8", 1), "ascii");
      case "v": return this.read(this.read("g"));
      case "(": case "{": {
        this.align(8);
        return members(type).map((member) => this.read(member));
      }
      case "a": {
        const element = type.slice(1);
        const length = this.number("UInt32", 4);
        this.align(ALIGN[element[0]]);
        const end = this.at + length;
        if (end > this.buffer.length) throw new Error("truncated D-Bus message");
        const items = [];
        while (this.at < end) items.push(this.read(element));
        return items;
      }
      default:
        throw new Error(`cannot read type ${type}`);
    }
  }
}

// One message: {type, flags, serial, path, interface, member, errorName, replySerial,
// destination, sender, signature, body: [...]}, little-endian.
export function encodeMessage(message) {
  const signature = message.signature || "";
  const body = new Writer();
  splitSignature(signature).forEach((type, index) => body.write(type, message.body[index]));
  const bodyBytes = body.done();
  const fields = [];
  for (const [code, name, type] of FIELDS) {
    const value = name === "signature" ? signature || undefined : message[name];
    if (value !== undefined) fields.push([code, [type, value]]);
  }
  const header = new Writer();
  header.write("y", 0x6c);
  header.write("y", message.type);
  header.write("y", message.flags || 0);
  header.write("y", 1);
  header.write("u", bodyBytes.length);
  header.write("u", message.serial);
  header.write("a(yv)", fields);
  header.align(8);
  return Buffer.concat([header.done(), bodyBytes]);
}

// The size of the first whole message in `buffer`, or 0 while more bytes are needed.
export function messageSize(buffer) {
  if (buffer.length < 16) return 0;
  if (buffer[0] !== 0x6c && buffer[0] !== 0x42) throw new Error("not a D-Bus message");
  const little = buffer[0] === 0x6c;
  const bodyLength = little ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
  const fieldsLength = little ? buffer.readUInt32LE(12) : buffer.readUInt32BE(12);
  const headerEnd = 16 + fieldsLength;
  const size = headerEnd + ((8 - (headerEnd % 8)) % 8) + bodyLength;
  return buffer.length >= size ? size : 0;
}

export function decodeMessage(buffer) {
  const reader = new Reader(buffer, buffer[0] === 0x6c);
  reader.at = 1;
  const message = { type: reader.read("y"), flags: reader.read("y") };
  reader.read("y");
  reader.read("u");
  message.serial = reader.read("u");
  for (const [code, value] of reader.read("a(yv)")) {
    const field = FIELDS.find(([known]) => known === code);
    if (field) message[field[1]] = value;
  }
  reader.align(8);
  message.signature ||= "";
  message.body = splitSignature(message.signature).map((type) => reader.read(type));
  return message;
}

// The socket of a D-Bus address: unix:path=..., unix:abstract=... or unix:runtime=yes.
export function socketOf(address, runtimeDir = process.env.XDG_RUNTIME_DIR) {
  for (const entry of String(address || "").split(";")) {
    const match = /^unix:(.*)$/.exec(entry);
    if (!match) continue;
    const keys = {};
    for (const pair of match[1].split(",")) {
      const at = pair.indexOf("=");
      if (at > 0) keys[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1));
    }
    if (keys.path) return keys.path;
    if (keys.abstract) return `\0${keys.abstract}`;
    if (keys.runtime === "yes" && runtimeDir) return `${runtimeDir}/bus`;
  }
  return runtimeDir ? `${runtimeDir}/bus` : "";
}

// SASL EXTERNAL: the bus checks our uid on the socket itself.
function authenticate(socket) {
  return new Promise((resolve, reject) => {
    let text = "";
    const onData = (chunk) => {
      text += chunk.toString("latin1");
      const end = text.indexOf("\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      if (!text.startsWith("OK ")) {
        reject(new Error("the session bus refused the connection"));
        return;
      }
      socket.write("BEGIN\r\n");
      resolve();
    };
    socket.on("data", onData);
    const uid = Buffer.from(String(process.getuid()), "ascii").toString("hex");
    socket.write(`\0AUTH EXTERNAL ${uid}\r\n`);
  });
}

class Bus extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.serial = 0;
    this.pending = new Map();
    this.input = Buffer.alloc(0);
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("the session bus connection closed"));
      this.pending.clear();
      this.emit("close");
    });
  }

  receive(chunk) {
    this.input = Buffer.concat([this.input, chunk]);
    for (;;) {
      let size;
      let message;
      try {
        size = messageSize(this.input);
        if (!size) return;
        message = decodeMessage(this.input.subarray(0, size));
      } catch (error) {
        this.socket.destroy();
        this.emit("error", error);
        return;
      }
      this.input = this.input.subarray(size);
      const waiting = message.replySerial !== undefined ? this.pending.get(message.replySerial) : null;
      if (waiting && (message.type === MESSAGE.return || message.type === MESSAGE.error)) {
        this.pending.delete(message.replySerial);
        if (message.type === MESSAGE.return) waiting.resolve(message);
        else waiting.reject(Object.assign(new Error(message.errorName || "D-Bus error"), { name: message.errorName, body: message.body }));
      } else this.emit("message", message);
    }
  }

  // Sends a message (a reply, a signal); returns its serial.
  send(fields) {
    const serial = ++this.serial;
    const flags = fields.type === MESSAGE.call ? fields.flags || 0 : (fields.flags || 0) | NO_REPLY_EXPECTED;
    this.socket.write(encodeMessage({ ...fields, flags, serial }));
    return serial;
  }

  // A method call; resolves with the reply's body, rejects with the error name.
  async call(fields) {
    return (await this.callMessage(fields)).body;
  }

  // Like call(), with the whole reply (its sender, for one).
  callMessage(fields) {
    return new Promise((resolve, reject) => {
      const serial = ++this.serial;
      this.pending.set(serial, { resolve, reject });
      this.socket.write(encodeMessage({ ...fields, type: MESSAGE.call, serial }));
    });
  }

  close() {
    this.socket.end();
    this.socket.destroy();
  }
}

// Connects, authenticates and says Hello; `bus.name` is the unique name the bus gave us.
export async function openBus(address = process.env.DBUS_SESSION_BUS_ADDRESS) {
  const path = socketOf(address);
  if (!path) throw new Error("no session bus address");
  const socket = connect(path);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  await authenticate(socket);
  const bus = new Bus(socket);
  socket.on("error", (error) => bus.emit("error", error));
  [bus.name] = await bus.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus",
    interface: "org.freedesktop.DBus", member: "Hello" });
  return bus;
}
