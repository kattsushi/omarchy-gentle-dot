// The avatar's state machine and geometry. Plain ECMAScript with no Node APIs: Avatar.qml
// imports it (import "avatar/mood.mjs" as Mood) and node:test checks it.

export const MOODS = ["idle", "sleepy", "searching", "thinking", "pondering", "focused", "talking",
  "alert", "listening", "busy", "worried", "surprised", "happy", "typing", "asleep", "waking"];

// The one expression the avatar shows for the chat's current state. Strongest first:
// a click (momentary) > disconnected > connecting > a notification surprise > needs you > voice
// > uploading > error > waking up > asleep > streaming > working > thinking > typing > idle.
// Disconnected ("sleepy") is its own sleepy look and wins over sleep from inactivity ("asleep").
//   connection: connecting | open | reconnecting | fatal | stopped; ready: hello answered
//   agentState: the daemon's agent_state; asks: pending ask count; voice: Voice.state
//   uploading, error, streaming (deltas flowing), typing, asleep (sleepDue): booleans
//   reaction: "" | happy (click) | surprised | waking (just woke up)
export function mood(input) {
  const s = input || {};
  if (s.reaction === "happy") return "happy";
  if (!s.connection || s.connection === "fatal" || s.connection === "stopped") return "sleepy";
  if (s.connection !== "open" || !s.ready) return "searching";
  if (s.reaction === "surprised") return "surprised";
  if (s.agentState === "needs_you" || s.asks > 0) return "alert";
  if (s.voice === "recording" || s.voice === "loading") return "listening";
  if (s.voice === "transcribing" || s.voice === "cancelling") return "pondering";
  if (s.uploading) return "busy";
  if (s.error || s.agentState === "error") return "worried";
  if (s.reaction === "waking") return "waking";
  if (s.asleep) return "asleep";
  if (s.streaming) return "talking";
  if (s.agentState === "working") return "focused";
  if (s.agentState === "thinking" || s.agentState === "starting" || s.agentState === "restarting") return "thinking";
  if (s.typing) return "typing";
  return "idle";
}

// What each mood looks like. Faces are drawn in a 100 x 100 box.
//   open: 1 lid up .. 0 shut; wide: eye scale; tilt: lid slant (> 0 inner corners lower,
//   focused/determined; < 0 outer corners lower, sad); pupil: pupil scale; lift: eyes
//   up (< 0) or down, in face units; smile: moustache tips up (> 0) or drooping (< 0);
//   curl: how far the tips are twirled at rest; puff: moustache puffed out at rest;
//   follow: pupils follow the pointer; gaze: where they rest otherwise (-1..1);
//   path: gaze points cycled while the mood lasts; extra: "", z, dots, !;
//   moustache: its gestures in this mood (see moustacheGestures); eyes: open | closed | happy;
//   motion: occasional body movement: breathe | hop | bounce | nod | none.
const BASE = { open: 1, wide: 1, tilt: 0, pupil: 1, lift: 0, smile: 0, curl: 0.3, puff: 0, follow: true,
  gaze: { x: 0, y: 0 }, path: [], extra: "", eyes: "open", motion: "breathe" };

const LOOKS = {
  idle: {},
  sleepy: { open: 0, follow: false, gaze: { x: 0, y: 0.5 }, smile: -0.8, curl: 0, extra: "z", eyes: "closed", lift: 3, motion: "none" },
  searching: { open: 0.85, follow: false, path: [{ x: -1, y: 0 }, { x: 1, y: -0.1 }, { x: -0.6, y: 0.4 }, { x: 0.8, y: 0.3 }], motion: "none" },
  thinking: { open: 0.85, follow: false, gaze: { x: 0.4, y: -0.9 }, path: [{ x: 0.5, y: -0.9 }, { x: -0.5, y: -0.8 }, { x: 0.1, y: -1 }], extra: "dots", lift: -2, motion: "none" },
  pondering: { open: 0.75, tilt: -0.2, follow: false, gaze: { x: -0.6, y: -0.8 }, path: [{ x: -0.7, y: -0.8 }, { x: -0.2, y: -1 }], extra: "dots", motion: "none" },
  focused: { open: 0.55, tilt: 0.35, follow: false, gaze: { x: 0.5, y: 0.6 }, motion: "none" },
  talking: { open: 0.95, smile: 0.25, motion: "none" },
  alert: { wide: 1.15, pupil: 0.8, lift: -4, smile: 0.1, extra: "!", motion: "hop" },
  listening: { wide: 1.12, pupil: 1.25, lift: -2, follow: false, gaze: { x: 0, y: -0.4 }, smile: 0.7, curl: 0.3, motion: "none" },
  busy: { open: 0.85, follow: false, path: [{ x: 0, y: -0.8 }, { x: 0, y: 0.9 }], extra: "dots", motion: "none" },
  worried: { open: 0.75, tilt: -0.45, pupil: 1.1, follow: false, gaze: { x: 0, y: 0.7 }, smile: -1, curl: 0, lift: 2, motion: "none" },
  surprised: { wide: 1.25, pupil: 0.65, lift: -5, follow: false, smile: 0.6, extra: "!", motion: "none" },
  happy: { follow: false, smile: 1, curl: 0.3, eyes: "happy", motion: "bounce" },
  typing: { open: 0.95, follow: false, gaze: { x: 1, y: 0.45 }, smile: 0.15, motion: "nod" },
  // No activity for a while: shut eyes, slow breathing, rising "zzZzZ".
  asleep: { open: 0, follow: false, gaze: { x: 0, y: 0.4 }, smile: -0.55, curl: 0.05, extra: "zzz", eyes: "closed", lift: 4, motion: "sleep" },
  // Just woke up: eyes opening wide, a stretch.
  waking: { open: 0.8, wide: 1.08, follow: false, gaze: { x: 0, y: -0.3 }, lift: -2, smile: 0.35, curl: 0.2, motion: "none" }
};

// --- sleep -------------------------------------------------------------------------------------

// The avatar falls asleep `minutes` after the last activity (both in ms since the epoch), exactly
// at the boundary; 0 (or a bad value) never sleeps, and neither does anything in progress
// (engaged: the agent working, a question waiting, dictation, an upload).
export function sleepDue(input) {
  const s = input || {};
  const minutes = typeof s.minutes === "number" ? s.minutes : NaN;
  if (!(minutes > 0) || s.engaged) return false;
  if (!Number.isFinite(s.now) || !Number.isFinite(s.lastActivity)) return false;
  return s.now - s.lastActivity >= minutes * 60000;
}

// The avatarSleepMinutes setting: whole minutes, 0 = never, at most a day; 30 when unset or bad.
export const DEFAULT_SLEEP_MINUTES = 30;
export function sleepMinutes(value) {
  const number = typeof value === "number" ? value : (typeof value === "string" && value.trim() ? Number(value) : NaN);
  if (!Number.isFinite(number) || number < 0) return DEFAULT_SLEEP_MINUTES;
  return Math.min(1440, Math.round(number));
}

export function expression(name) {
  return Object.assign({}, BASE, LOOKS[name] || LOOKS.idle, { moustache: moustacheGestures(name) });
}

// Unit vector from the eye toward a point, scaled by how far the point is (1 at `reach`).
export function gazeToward(ex, ey, tx, ty, reach) {
  const dx = tx - ex, dy = ty - ey, d = Math.hypot(dx, dy);
  if (!(d > 0)) return { x: 0, y: 0 };
  const s = Math.min(1, d / (reach > 0 ? reach : 1));
  return { x: dx / d * s, y: dy / d * s };
}

const n = value => String(Number(value.toFixed(2)) + 0);

// The lid line in eye-centred coordinates: y = m * x + c.
function lid(eye) {
  const open = Math.min(1, Math.max(0, eye.open));
  return { m: (eye.tilt || 0) * 0.5 * eye.ry / eye.rx * (eye.inward || 1), c: -eye.ry + (1 - open) * 2 * eye.ry };
}

// SVG path of the visible part of an eye: the ellipse (cx, cy, rx, ry) below its lid.
// "" when the lid shuts it completely.
export function eyePath(eye) {
  const { cx, cy, rx, ry } = eye;
  const { m, c } = lid(eye);
  // x²/rx² + (m x + c)²/ry² = 1
  const a = 1 / (rx * rx) + m * m / (ry * ry), b = 2 * m * c / (ry * ry), k = c * c / (ry * ry) - 1;
  const disc = b * b - 4 * a * k;
  if (disc <= 0) {
    if (c > 0) return "";
    return `M ${n(cx - rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 1 1 ${n(cx + rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 1 1 ${n(cx - rx)} ${n(cy)} Z`;
  }
  const x1 = (-b - Math.sqrt(disc)) / (2 * a), x2 = (-b + Math.sqrt(disc)) / (2 * a);
  const p1 = [cx + x1, cy + m * x1 + c], p2 = [cx + x2, cy + m * x2 + c];
  // From the right end of the lid, clockwise under the eye back to the left end;
  // that arc is the large one when the eye's centre is still visible.
  const large = c < 0 ? 1 : 0;
  return `M ${n(p1[0])} ${n(p1[1])} L ${n(p2[0])} ${n(p2[1])} A ${n(rx)} ${n(ry)} 0 ${large} 1 ${n(p1[0])} ${n(p1[1])} Z`;
}

// Pupil offset from the eye centre and its radius for a gaze (-1..1 each way; longer vectors
// are shortened): inside the eye and below the lid, shrinking when the lid narrows the eye.
//   eye: {cx, cy, rx, ry, open, tilt, inward, pr}
export function pupilOffset(eye, gx, gy) {
  const { rx, ry } = eye;
  const { m, c } = lid(eye);
  const top = Math.max(-ry, c);
  const half = Math.max(0, (ry - top) / 2);
  const r = Math.max(0.5, Math.min(eye.pr, half * 0.85, rx * 0.6));
  const centre = (top + ry) / 2;
  const valid = (x, y) => (x / (rx - r)) ** 2 + (y / (ry - r)) ** 2 <= 1 && y - r >= m * x + c + Math.abs(m) * r - 1e-9;
  let start = { x: 0, y: centre };
  if (!valid(start.x, start.y)) start = { x: 0, y: ry - r };
  const length = Math.hypot(gx || 0, gy || 0);
  const scale = length > 1 ? 1 / length : 1;
  const target = { x: (gx || 0) * scale * (rx - r), y: centre + (gy || 0) * scale * Math.max(0, half - r) };
  let point = target;
  if (!valid(target.x, target.y)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const t = (lo + hi) / 2;
      if (valid(start.x + (target.x - start.x) * t, start.y + (target.y - start.y) * t)) lo = t;
      else hi = t;
    }
    point = { x: start.x + (target.x - start.x) * lo, y: start.y + (target.y - start.y) * lo };
  }
  return { x: point.x + 0, y: point.y + 0, r };
}

// --- moustache -------------------------------------------------------------------------------

// Gesture offsets, added to the mood's pose. Shape: lr/rr tip raise and lc/rc curl
// (left/right), puff. Moves (transforms, cheap to animate): sway (sideways, face units, > 0
// right), tilt (degrees, > 0 clockwise: the right tip goes down), lift (the lip lifting it,
// 0..1) and lflap/rflap (one half turned about the middle, degrees, > 0 tip up).
export const REST = Object.freeze({ lr: 0, rr: 0, lc: 0, rc: 0, puff: 0, sway: 0, tilt: 0, lift: 0, lflap: 0, rflap: 0 });
const KEYS = Object.keys(REST);

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, Number(value) || 0));
const RAD = Math.PI / 180;
const SPINE_POINTS = 21;

// The centre line of the right half of the handlebar moustache, root at the middle of the lip,
// as points {x, y, heading (radians, counter-clockwise, unwrapped), width}.
//   raise: tips up (> 0, up to 1.6) or drooping (< 0, down to -1.8); curl: 0 .. 1.2, the tip
//   winds into a spiral (more than one turn at 1, tighter toward the end); puff: 0 .. 1.2, wider
//   and thicker.
// The heading is a smooth function of the length along the line, so every pose stays smooth.
export function moustacheSpine(params) {
  const p = typeof params === "number" ? { raise: params } : (params || {});
  const raise = clamp(p.raise, -1.8, 1.6), curl = clamp(p.curl, 0, 1.2);
  const puff = clamp(p.puff, 0, 1.2);
  const length = 44 * (1 + 0.1 * puff) * (1 + 0.18 * curl);
  const start = -8 + raise * 6, turn = 52 + raise * (raise > 0 ? 55 : 48), twirl = 430 * curl;
  // Flat where the halves meet (no notch at the middle), then the pose's slant.
  const flat = u => { const k = Math.min(1, u / 0.18); return k * k * (3 - 2 * k); };
  const heading = u => (start * flat(u) + turn * u * u + twirl * Math.pow(Math.max(0, (u - 0.5) / 0.5), 2.6)) * RAD;
  // Samples closer together toward the tip, where the curl bends most.
  const at = i => 1 - Math.pow(1 - i / (SPINE_POINTS - 1), 1.5);
  const raw = [{ x: 49.2, y: 71 }];
  for (let i = 1; i < SPINE_POINTS; i++) {
    const h = heading((at(i - 1) + at(i)) / 2), ds = (at(i) - at(i - 1)) * length, last = raw[i - 1];
    raw.push({ x: last.x + Math.cos(h) * ds, y: last.y - Math.sin(h) * ds });
  }
  const points = raw.map((point, i) => {
    const u = at(i);
    // Thick in the middle, waxed thin toward the tip; a twirled tip is thinner still.
    const taper = 9.6 * Math.pow(1 - Math.pow(u, 1.7), 0.85) + 1.1 * u;
    const waxed = 1 - 0.35 * curl * Math.min(1, Math.max(0, (u - 0.5) / 0.5));
    return { x: point.x, y: point.y, width: taper * waxed * (1 + 0.5 * puff * (1 - u)) };
  });
  // Headings of the drawn line, unwrapped so turns add up.
  let total = 0, previous = null;
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const h = Math.atan2(-(b.y - a.y), b.x - a.x);
    if (previous === null) total = h;
    else total += Math.atan2(Math.sin(h - previous), Math.cos(h - previous));
    previous = h;
    points[i].heading = total;
  }
  return points;
}

// Smooth cubic segments through points (Catmull-Rom), as " C ..." commands after the first point.
function through(points, p) {
  let out = "";
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[Math.max(0, i - 1)], b = points[i], c = points[i + 1], d = points[Math.min(points.length - 1, i + 2)];
    out += ` C ${p(b.x + (c.x - a.x) / 6, b.y + (c.y - a.y) / 6)} ${p(c.x - (d.x - b.x) / 6, c.y - (d.y - b.y) / 6)} ${p(c.x, c.y)}`;
  }
  return out;
}

// SVG path of one half of the handlebar moustache (side 1 right, -1 left), a closed outline of
// cubic curves around moustacheSpine; the halves mirror each other at x = 50 and each reaches
// a hair past the middle so no seam shows. params: {raise, curl, puff} or a number
// (raise, the old smile argument).
export function moustachePath(side, params) {
  const spine = moustacheSpine(params);
  const mirror = side < 0;
  const p = (px, py) => `${n(mirror ? 100 - px : px)} ${n(py)}`;
  const edge = sign => spine.map(point => ({
    x: point.x - Math.sin(point.heading) * point.width / 2 * sign,
    y: point.y - Math.cos(point.heading) * point.width / 2 * sign
  }));
  const upper = edge(1), lower = edge(-1).reverse();
  const tip = spine[spine.length - 1], reach = tip.width * 0.7;
  const dx = Math.cos(tip.heading) * reach, dy = -Math.sin(tip.heading) * reach;
  const a = upper[upper.length - 1], b = lower[0];
  return `M ${p(upper[0].x, upper[0].y)}${through(upper, p)}`
    + ` C ${p(a.x + dx, a.y + dy)} ${p(b.x + dx, b.y + dy)} ${p(b.x, b.y)}`
    + `${through(lower, p)} Z`;
}

// One half's shape: the mood's pose (expression: smile, curl, puff) plus the current gesture
// offsets (sampleGesture) for that side (1 right, -1 left).
export function moustacheSide(pose, offsets, side) {
  const o = offsets || REST, left = side < 0;
  return { raise: pose.smile + (left ? o.lr : o.rr), curl: pose.curl + (left ? o.lc : o.rc), puff: pose.puff + o.puff };
}

// --- moustache gestures ----------------------------------------------------------------------

// What the moustache does in each mood: entry plays once when the mood starts, loop plays
// over and over while it lasts, gesture plays every `every` ms (a random delay in that range),
// key plays on each typing nod. Mamma mia, che bigote.
const MOUSTACHE = {
  idle: { every: [10000, 20000], gesture: "proud" },
  sleepy: { every: [4000, 6500], gesture: "doze" },
  searching: { every: [1800, 3200], gesture: "tic" },
  thinking: { loop: "hmm" },
  pondering: { loop: "hmm" },
  focused: { every: [1100, 1700], gesture: "twitch" },
  talking: { loop: "talk" },
  alert: { entry: "cheeky", every: [2400, 3600], gesture: "cheeky" },
  listening: { entry: "perk" },
  busy: { every: [1100, 1700], gesture: "twitch" },
  worried: { entry: "mammamia" },
  surprised: { entry: "puff" },
  happy: {},
  typing: { key: "tic" },
  asleep: { every: [3000, 5500], gesture: "snooze" },
  waking: { entry: "wakeup" }
};

export function moustacheGestures(name) {
  return Object.assign({}, MOUSTACHE[name] || MOUSTACHE.idle);
}

// One-off reactions: a click (variants in turn), a reply that finished ("¡listo!"), a toast.
const CLICKS = ["grandTwirl", "shimmy", "cheeky"];
export function reactionGesture(event, variant) {
  if (event === "click") return CLICKS[(variant || 0) % CLICKS.length];
  if (event === "reply") return "listo";
  if (event === "toast") return "puff";
  return "";
}

// Swap left and right: the same gesture on the other side.
const mirrorFrame = f => {
  const out = Object.assign({}, f, { lr: f.rr, rr: f.lr, lc: f.rc, rc: f.lc, lflap: f.rflap, rflap: f.lflap });
  if (f.sway) out.sway = -f.sway;
  if (f.tilt) out.tilt = -f.tilt;
  for (const key of KEYS) if (out[key] === undefined) delete out[key];
  return out;
};
const onRight = frames => frames;
const onLeft = frames => frames.map(mirrorFrame);
// Copy a right-side frame to both sides.
const both = f => Object.assign({}, f, f.rr !== undefined ? { lr: f.rr } : {}, f.rc !== undefined ? { lc: f.rc } : {});

// Keyframes: t (ms), offsets (missing ones are 0) and the easing into that frame:
// io (in-out, default), out, in, back (overshoots a little).
const BUILD = {
  settle: () => [{ t: 0 }, { t: 260 }],
  // Idle pride: one tip (or both) twirled up and let go.
  proud: random => {
    const r = random();
    const twirl = [{ t: 0 }, { t: 380, rr: 0.35, rc: 0.55, tilt: -1.5 }, { t: 850, rr: 0.5, rc: 1, puff: 0.08, tilt: -2.5 },
      { t: 1250, rr: 0.5, rc: 1, puff: 0.08, tilt: -2.5 }, { t: 1800, rr: 0.15, rc: 0.15 }, { t: 2150 }];
    if (r < 0.25) return twirl.map(f => Object.assign(both(f), { tilt: 0 }));
    return r < 0.6 ? onLeft(twirl) : onRight(twirl);
  },
  // Click: the grand double twirl, both tips, twice.
  grandTwirl: () => [{ t: 0 }, { t: 350, rr: 0.5, rc: 1, puff: 0.1 }, { t: 650, rr: 0.35, rc: 0.3 },
    { t: 1000, rr: 0.7, rc: 1.1, puff: 0.15 }, { t: 1300, rr: 0.7, rc: 1.1, puff: 0.15 }, { t: 1750 }].map(both),
  // Click: a quick side-to-side shimmy, the tips see-sawing.
  shimmy: () => [{ t: 0 }, { t: 70, sway: 2.5, lr: 0.3, rr: -0.3, ease: "out" }, { t: 170, sway: -2.5, lr: -0.3, rr: 0.3 },
    { t: 270, sway: 2.5, lr: 0.3, rr: -0.3 }, { t: 370, sway: -2.5, lr: -0.3, rr: 0.3 }, { t: 460, sway: 1.5, lr: 0.15, rr: -0.15 },
    { t: 540, sway: -1 }, { t: 650 }],
  // Needs you, click: one tip up (wiggling), the other down. A wink of a moustache.
  cheeky: random => {
    const up = [{ t: 0 }, { t: 180, lr: 1, rr: -0.45, sway: -1, tilt: 3, ease: "back" }, { t: 300, lr: 0.75, rr: -0.45, sway: -0.2, tilt: 3 },
      { t: 420, lr: 1, rr: -0.45, sway: -1.2, tilt: 3 }, { t: 540, lr: 0.75, rr: -0.45, sway: -0.2, tilt: 3 },
      { t: 660, lr: 1, rr: -0.45, sway: -1, tilt: 3 }, { t: 1000, lr: 1, rr: -0.45, sway: -1, tilt: 3 }, { t: 1350 }];
    return random() < 0.5 ? up : up.map(mirrorFrame);
  },
  // A reply finished: a satisfied twirl, "¡listo!".
  listo: () => [{ t: 0 }, { t: 200, rr: 0.2, puff: 0.1 }, { t: 550, rr: 0.6, rc: 0.85, puff: 0.2, ease: "out" },
    { t: 1100, rr: 0.6, rc: 0.85, puff: 0.1 }, { t: 1500 }].map(both),
  // Surprise: puffs out and settles with a little bounce.
  puff: () => [{ t: 0 }, { t: 110, puff: 1, lr: 0.4, rr: 0.4, ease: "out" }, { t: 300, puff: 0.35, lr: 0.2, rr: 0.2 },
    { t: 430, puff: 0.6, lr: 0.3, rr: 0.3 }, { t: 800 }],
  // Working: a determined twitch, twice, on one side.
  twitch: random => {
    const frames = [{ t: 0 }, { t: 70, rr: 0.6, ease: "out" }, { t: 200 }, { t: 260, rr: 0.35, ease: "out" }, { t: 380 }];
    return random() < 0.5 ? onLeft(frames) : onRight(frames);
  },
  // Typing, searching: a small twitch.
  tic: () => [{ t: 0 }, { t: 60, lr: 0.25, rr: 0.25, ease: "out" }, { t: 180 }],
  // Thinking: one tip twirls slowly while the other sags a little. Hmm.
  hmm: random => {
    const frames = [{ t: 0 }, { t: 1100, rr: 0.3, rc: 0.9, lr: -0.15 }, { t: 1700, rr: 0.3, rc: 0.9, lr: -0.15 },
      { t: 2500, rr: 0.1, rc: 0.2, lr: -0.1 }, { t: 2900 }];
    return random() < 0.3 ? onLeft(frames) : onRight(frames);
  },
  // Streaming: syllables of different length and strength, the lip lifting the moustache and
  // each half flapping on its own, now and then an emphatic sway and a breath between words.
  // Moves only (no change of shape), so talking for minutes stays cheap.
  talk: random => {
    const frames = [{ t: 0 }];
    let t = 0;
    const syllables = 3 + Math.floor(random() * 4);
    for (let i = 0; i < syllables; i++) {
      t += Math.round(50 + random() * 80);
      const lift = 0.35 + random() * 0.65;
      const lflap = lift * 5 + (random() - 0.5) * 8, rflap = lift * 5 + (random() - 0.5) * 8;
      const frame = { t, lift, lflap, rflap, ease: "out" };
      if (random() < 0.2) frame.sway = (random() - 0.5) * 2;
      frames.push(frame);
      t += Math.round(60 + random() * 90);
      frames.push({ t, lift: random() * 0.2, lflap: lflap * 0.3, rflap: rflap * 0.3 });
      if (random() < 0.25) {
        t += Math.round(80 + random() * 180);
        frames.push({ t, lflap: lflap * 0.1, rflap: rflap * 0.1 });
      }
    }
    frames.push({ t: t + 90 });
    return frames;
  },
  // An error: a dramatic droop and a despairing shake. Mamma mia.
  mammamia: () => [{ t: 0 }, { t: 500, lr: -0.9, rr: -0.9, puff: 0.1, ease: "out" },
    { t: 600, lr: -0.9, rr: -0.9, puff: 0.1, sway: 1.2 }, { t: 700, lr: -0.9, rr: -0.9, puff: 0.1, sway: -1.2 },
    { t: 800, lr: -0.9, rr: -0.9, sway: 1 }, { t: 900, lr: -0.9, rr: -0.9, sway: -0.8 }, { t: 1000, lr: -0.9, rr: -0.9 },
    { t: 1500, lr: -0.8, rr: -0.8 }, { t: 2100 }],
  // Disconnected: a slow sleepy breath, the tips sagging and coming back.
  doze: () => [{ t: 0 }, { t: 1400, lr: -0.4, rr: -0.4, puff: 0.12 }, { t: 1700, lr: -0.4, rr: -0.4, puff: 0.12 }, { t: 3000 }],
  // Asleep: a slow droop, both halves sagging; now and then a snore (the lip blows the moustache
  // up) or one tip twitching in a dream. Moves only, like talk: sleeping for hours stays cheap.
  snooze: random => {
    const r = random();
    const droop = [{ t: 0 }, { t: 1600, lflap: -7, rflap: -7 }, { t: 2000, lflap: -7, rflap: -7 }];
    if (r < 0.3) return droop.concat([{ t: 2250, lift: 0.8, lflap: 4, rflap: 4, ease: "out" },
      { t: 2600, lift: 0.3, lflap: -2, rflap: -2 }, { t: 3400 }]);
    if (r < 0.5) {
      const frames = droop.concat([{ t: 2150, lflap: -7, rflap: 5, ease: "out" },
        { t: 2300, lflap: -7, rflap: -7 }, { t: 3300 }]);
      return r < 0.4 ? onRight(frames) : onLeft(frames);
    }
    return droop.concat([{ t: 3300 }]);
  },
  // Waking up: a yawn and a stretch (puffed, tips up), then a shake.
  wakeup: () => [{ t: 0 }, { t: 300, lr: 0.6, rr: 0.6, puff: 0.5, ease: "out" }, { t: 620, lr: 0.75, rr: 0.75, puff: 0.6 },
    { t: 740, lr: 0.3, rr: 0.3, puff: 0.2, sway: 2.2 }, { t: 840, sway: -2.2 }, { t: 940, sway: 1.6 }, { t: 1040, sway: -1.1 },
    { t: 1200 }],
  // Recording: attentive, the tips spring up.
  perk: () => [{ t: 0 }, { t: 150, lr: 0.5, rr: 0.5, puff: 0.15, ease: "back" }, { t: 400, lr: 0.2, rr: 0.2 }, { t: 700 }]
};

export const GESTURES = Object.keys(BUILD);

// A gesture ready to play: {name, duration, frames}. random() picks the side and, for talk,
// the syllables (Math.random when playing; fixed values in tests).
export function gestureFrames(name, random) {
  const build = BUILD[name] || BUILD.settle;
  const frames = build(random || Math.random);
  return { name: BUILD[name] ? name : "settle", duration: frames[frames.length - 1].t, frames };
}

const EASE = {
  io: s => s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2,
  out: s => 1 - Math.pow(1 - s, 3),
  in: s => s * s * s,
  back: s => 1 + 2.2 * Math.pow(s - 1, 3) + 1.2 * Math.pow(s - 1, 2)
};
// How long a new gesture takes to blend out of wherever the last one left the moustache.
const BLEND = 220;

// The offsets at t ms into a gesture. from: the offsets when it started (they fade out over
// the first BLEND ms, so one gesture flows into the next).
export function sampleGesture(gesture, t, from) {
  const out = Object.assign({}, REST);
  if (gesture && gesture.frames.length) {
    const frames = gesture.frames;
    let k = 0;
    while (k < frames.length - 2 && t >= frames[k + 1].t) k++;
    const a = frames[k], b = frames[Math.min(k + 1, frames.length - 1)];
    const span = b.t - a.t;
    const s = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 1;
    const e = s <= 0 ? 0 : s >= 1 ? 1 : (EASE[b.ease] || EASE.io)(s);
    for (const key of KEYS) {
      const from = a[key] || 0, to = b[key] || 0;
      out[key] = from === to ? from : from * (1 - e) + to * e;
    }
  }
  if (from) {
    const blend = Math.min(BLEND, gesture ? gesture.duration : 0);
    const keep = blend > 0 ? 1 - EASE.io(Math.min(1, Math.max(0, t / blend))) : 0;
    for (const key of KEYS) out[key] += (from[key] || 0) * keep;
  }
  for (const key of KEYS) out[key] += 0;
  return out;
}

// A random delay in [min, max] ms, e.g. the next idle twirl.
export function nextDelay(range, random) {
  if (!range) return 0;
  return Math.round(range[0] + (range[1] - range[0]) * (random || Math.random)());
}
