import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mood, expression, MOODS, eyePath, pupilOffset, gazeToward, moustachePath, moustacheSpine, moustacheSide,
  moustacheGestures, reactionGesture, GESTURES, gestureFrames, sampleGesture, nextDelay, REST, sleepDue, sleepMinutes } from '../avatar/mood.mjs';

const live = { connection: 'open', ready: true, agentState: 'idle' };
const at = extra => mood({ ...live, ...extra });

test('every chat state has its own mood', () => {
  assert.equal(at({}), 'idle');
  assert.equal(mood({ connection: 'fatal' }), 'sleepy');
  assert.equal(mood({ connection: 'stopped' }), 'sleepy');
  assert.equal(mood(null), 'sleepy');
  assert.equal(mood({ connection: 'connecting' }), 'searching');
  assert.equal(mood({ connection: 'reconnecting' }), 'searching');
  assert.equal(mood({ connection: 'open', ready: false }), 'searching');
  assert.equal(at({ agentState: 'thinking' }), 'thinking');
  assert.equal(at({ agentState: 'starting' }), 'thinking');
  assert.equal(at({ agentState: 'restarting' }), 'thinking');
  assert.equal(at({ agentState: 'working' }), 'focused');
  assert.equal(at({ agentState: 'working', streaming: true }), 'talking');
  assert.equal(at({ agentState: 'needs_you' }), 'alert');
  assert.equal(at({ asks: 1 }), 'alert');
  assert.equal(at({ reaction: 'surprised' }), 'surprised');
  assert.equal(at({ error: true }), 'worried');
  assert.equal(at({ agentState: 'error' }), 'worried');
  assert.equal(at({ voice: 'recording' }), 'listening');
  assert.equal(at({ voice: 'loading' }), 'listening');
  assert.equal(at({ voice: 'transcribing' }), 'pondering');
  assert.equal(at({ voice: 'cancelling' }), 'pondering');
  assert.equal(at({ uploading: true }), 'busy');
  assert.equal(at({ typing: true }), 'typing');
  assert.equal(at({ reaction: 'happy' }), 'happy');
});

test('priority: disconnected wins, then needs_you > streaming > thinking > typing > idle', () => {
  const everything = { agentState: 'needs_you', asks: 2, streaming: true, typing: true, voice: 'recording',
    uploading: true, error: true, reaction: 'surprised' };
  assert.equal(mood({ connection: 'fatal', ...everything }), 'sleepy');
  assert.equal(mood({ connection: 'reconnecting', ...everything }), 'searching');
  assert.equal(at({ agentState: 'needs_you', streaming: true }), 'alert');
  assert.equal(at({ agentState: 'thinking', streaming: true }), 'talking');
  assert.equal(at({ agentState: 'thinking', typing: true }), 'thinking');
  assert.equal(at({ agentState: 'idle', typing: true, error: false }), 'typing');
  assert.equal(at({ voice: 'recording', agentState: 'needs_you' }), 'alert');
  assert.equal(at({ voice: 'recording', uploading: true, streaming: true }), 'listening');
  assert.equal(at({ uploading: true, streaming: true }), 'busy');
  assert.equal(at({ error: true, streaming: true }), 'worried');
  assert.equal(at({ reaction: 'surprised', agentState: 'needs_you' }), 'surprised');
});

test('a click reaction is momentary and shows even while asleep', () => {
  assert.equal(mood({ connection: 'fatal', reaction: 'happy' }), 'happy');
  assert.equal(mood({ connection: 'fatal', reaction: 'surprised' }), 'sleepy');
  assert.equal(at({ reaction: 'unknown' }), 'idle');
});

test('every mood has a complete expression; unknown names fall back to idle', () => {
  for (const name of MOODS) {
    const look = expression(name);
    for (const key of ['open', 'wide', 'tilt', 'pupil', 'lift', 'smile', 'curl', 'puff', 'follow', 'gaze', 'path', 'extra', 'moustache', 'eyes'])
      assert.ok(key in look, `${name}.${key}`);
    assert.ok(look.open >= 0 && look.open <= 1, name);
  }
  assert.deepEqual(expression('nope'), expression('idle'));
  assert.equal(expression('sleepy').eyes, 'closed');
  assert.equal(expression('sleepy').extra, 'z');
  assert.equal(expression('happy').eyes, 'happy');
  assert.equal(expression('alert').extra, '!');
  assert.equal(expression('thinking').extra, 'dots');
  assert.equal(expression('talking').moustache.loop, 'talk');
  assert.equal(expression('focused').moustache.gesture, 'twitch');
  assert.equal(expression('idle').follow, true);
  assert.equal(expression('searching').follow, false);
  assert.ok(expression('searching').path.length >= 2);
  assert.ok(expression('typing').gaze.x > 0, 'typing glances at the field on the right');
  assert.ok(expression('worried').smile < 0 && expression('happy').smile > 0);
});

const eye = { cx: 30, cy: 40, rx: 12, ry: 15 };

test('eye path: full ellipse when open, nothing when closed, a lid cut in between', () => {
  const full = eyePath({ ...eye, open: 1, tilt: 0, inward: 1 });
  assert.match(full, /^M 18 40 A 12 15 0 1 1 42 40 A 12 15 0 1 1 18 40 Z$/);
  assert.equal(eyePath({ ...eye, open: 0, tilt: 0, inward: 1 }), '');
  const half = eyePath({ ...eye, open: 0.5, tilt: 0, inward: 1 });
  // A flat lid through the centre: from the left edge to the right edge, then the lower half.
  assert.match(half, /^M 18 40 L 42 40 A 12 15 0 [01] 1 18 40 Z$/);
  const tilted = eyePath({ ...eye, open: 0.7, tilt: 0.4, inward: 1 }).match(/^M (\S+) (\S+) L (\S+) (\S+) /);
  // Inward is +x here: the inner (right) corner of the lid sits lower.
  assert.ok(Number(tilted[4]) > Number(tilted[2]));
});

test('pupils stay inside the eye for any gaze, also with the lid half closed', () => {
  const pr = 5;
  for (const open of [1, 0.6, 0.35]) {
    for (let angle = 0; angle < 360; angle += 15) {
      const g = { x: Math.cos(angle * Math.PI / 180) * 50, y: Math.sin(angle * Math.PI / 180) * 50 };
      const p = pupilOffset({ ...eye, open, tilt: 0, pr }, g.x, g.y);
      const x = eye.cx + p.x, y = eye.cy + p.y;
      // Inside the ellipse shrunk by the pupil radius (with a hair of tolerance).
      const inside = ((x - eye.cx) / (eye.rx - p.r)) ** 2 + ((y - eye.cy) / (eye.ry - p.r)) ** 2;
      assert.ok(inside <= 1.0001, `open ${open} angle ${angle}: ${inside}`);
      const lid = eye.cy - eye.ry + (1 - open) * 2 * eye.ry;
      assert.ok(y - p.r >= lid - 0.01, `below the lid at open ${open} angle ${angle}`);
      assert.ok(p.r <= pr && p.r > 0);
    }
  }
  assert.deepEqual(pupilOffset({ ...eye, open: 1, tilt: 0, pr }, 0, 0), { x: 0, y: 0, r: pr });
});

test('gaze toward a point: direction with strength growing with distance, capped at 1', () => {
  const near = gazeToward(0, 0, 3, 4, 50);
  assert.ok(Math.abs(near.x - 0.06) < 1e-9 && Math.abs(near.y - 0.08) < 1e-9);
  const far = gazeToward(0, 0, 3000, 4000, 50);
  assert.ok(Math.abs(far.x - 0.6) < 1e-9 && Math.abs(far.y - 0.8) < 1e-9);
  assert.deepEqual(gazeToward(5, 5, 5, 5, 50), { x: 0, y: 0 });
});

// --- moustache (S15.5) ----------------------------------------------------------------------

const numbers = path => path.match(/-?\d+(\.\d+)?/g).map(Number);
const seq = (...values) => { let i = 0; return () => values[i++ % values.length]; };

test('moustache: every pose is one valid closed path of cubic curves inside the face', () => {
  for (const side of [1, -1])
    for (const raise of [-1.8, -1, 0, 0.5, 1, 1.6])
      for (const curl of [0, 0.2, 0.6, 1, 1.2])
        for (const puff of [0, 1]) {
            const params = { raise, curl, puff };
            const path = moustachePath(side, params);
            const label = JSON.stringify({ side, ...params });
            assert.match(path, /^M [^MZ]+Z$/, label);
            assert.match(path, /^[MCLZ0-9 .-]+$/, label);
            assert.ok(path.split(' C ').length > 12, `smooth cubic outline ${label}`);
            const values = numbers(path);
            assert.equal(values.length % 2, 0, label);
            for (let i = 0; i < values.length; i += 2) {
              assert.ok(Number.isFinite(values[i]) && values[i] >= 0 && values[i] <= 100, `x in the face ${label}`);
              assert.ok(values[i + 1] >= 30 && values[i + 1] <= 100, `y below the eyes' middle ${label}: ${values[i + 1]}`);
            }
            // The outline never folds over itself: the spine bends more gently than its half width.
            const spine = moustacheSpine(params);
            for (let i = 1; i < spine.length - 1; i++) {
              const a = spine[i - 1], b = spine[i], c = spine[i + 1];
              const turn = Math.abs(Math.atan2(Math.sin(c.heading - a.heading), Math.cos(c.heading - a.heading)));
              const radius = Math.hypot(c.x - a.x, c.y - a.y) / Math.max(turn, 1e-9);
              assert.ok(radius >= b.width / 2 * 0.95, `no fold at ${i} ${label}: r ${radius} w ${b.width}`);
            }
          }
});

test('moustache: neutral halves mirror each other at x = 50; any pose mirrors between sides', () => {
  for (const params of [0, { raise: 0, curl: 0 }, { raise: 0.7, curl: 1, puff: 0.5 }, { raise: -1.5 }]) {
    const right = numbers(moustachePath(1, params)), left = numbers(moustachePath(-1, params));
    assert.equal(right.length, left.length);
    for (let i = 0; i < right.length; i += 2) {
      assert.ok(Math.abs(right[i] + left[i] - 100) < 0.011, `mirrored x ${i}`);
      assert.equal(right[i + 1], left[i + 1]);
    }
  }
  // Each half reaches a hair past the middle so no seam shows.
  assert.ok(Math.min(...numbers(moustachePath(1, 0)).filter((_, i) => i % 2 === 0)) < 50);
});

test('moustache: raise lifts the tips, droop drops them, curl winds a spiral, puff widens', () => {
  const tip = params => { const spine = moustacheSpine(params); return spine[spine.length - 1]; };
  const root = moustacheSpine({})[0];
  assert.ok(tip({ raise: 1 }).y < tip({}).y - 3, 'raised tip higher');
  assert.ok(tip({ raise: -1 }).y > tip({}).y + 3, 'drooping tip lower');
  assert.ok(tip({ raise: -1 }).y > root.y, 'a droop hangs below the root');
  assert.ok(tip({}).y < root.y, 'neutral handlebar tips point up');
  // Number form is the old smile argument.
  assert.equal(moustachePath(1, 0.5), moustachePath(1, { raise: 0.5 }));
  const curled = moustacheSpine({ curl: 1 }), straight = moustacheSpine({ curl: 0 });
  const turned = curled[curled.length - 1].heading - curled[0].heading;
  assert.ok(turned > 2 * Math.PI, `a full curl turns more than once: ${turned}`);
  assert.ok(straight[straight.length - 1].heading - straight[0].heading < Math.PI / 2);
  assert.ok(tip({ curl: 1 }).x < tip({}).x - 4, 'the curled tip winds back in');
  // Spiral: each quarter turn of the curl is tighter than the one before.
  const radii = [];
  for (let i = 1; i < curled.length - 1; i++) {
    const turn = curled[i + 1].heading - curled[i - 1].heading;
    if (turn > 0.05) radii.push(Math.hypot(curled[i + 1].x - curled[i - 1].x, curled[i + 1].y - curled[i - 1].y) / turn);
  }
  assert.ok(radii.length > 4 && radii[radii.length - 1] < radii[0] / 2, `tightening ${radii}`);
  const width = params => Math.max(...moustacheSpine(params).map(p => p.width));
  const span = params => Math.max(...numbers(moustachePath(1, params)).filter((_, i) => i % 2 === 0));
  assert.ok(width({ puff: 1 }) > width({}) * 1.3, 'puffed is thicker');
  assert.ok(span({ puff: 1 }) > span({}) + 2, 'puffed is wider');
});

test('moustache: each mood has its gesture; reactions pick theirs', () => {
  const g = name => moustacheGestures(name);
  assert.deepEqual(g('idle'), { every: [10000, 20000], gesture: 'proud' });
  assert.equal(g('typing').key, 'tic');
  assert.equal(g('thinking').loop, 'hmm');
  assert.equal(g('pondering').loop, 'hmm');
  assert.equal(g('focused').gesture, 'twitch');
  assert.equal(g('busy').gesture, 'twitch');
  assert.equal(g('talking').loop, 'talk');
  assert.equal(g('alert').entry, 'cheeky');
  assert.equal(g('alert').gesture, 'cheeky');
  assert.equal(g('surprised').entry, 'puff');
  assert.equal(g('worried').entry, 'mammamia');
  assert.equal(g('sleepy').gesture, 'doze');
  assert.equal(g('listening').entry, 'perk');
  assert.ok(expression('listening').smile > 0.5, 'attentive: tips up');
  assert.ok(expression('sleepy').smile < -0.5 && expression('worried').smile < -0.5, 'drooping tips');
  assert.deepEqual(g('nope'), g('idle'));
  for (const name of MOODS) {
    const entry = g(name);
    for (const key of ['entry', 'loop', 'gesture', 'key']) if (entry[key]) assert.ok(GESTURES.includes(entry[key]), `${name}.${key}`);
    if (entry.every) assert.ok(entry.every[0] > 0 && entry.every[1] >= entry.every[0]);
  }
  assert.deepEqual([0, 1, 2, 3].map(v => reactionGesture('click', v)), ['grandTwirl', 'shimmy', 'cheeky', 'grandTwirl']);
  assert.equal(reactionGesture('reply'), 'listo');
  assert.equal(reactionGesture('toast'), 'puff');
  assert.equal(reactionGesture('nope'), '');
});

test('gestures: keyframes start and end at rest, in order, and stay within the moustache limits', () => {
  for (const name of GESTURES)
    for (const random of [() => 0, () => 0.5, () => 0.99, Math.random]) {
      const g = gestureFrames(name, random);
      assert.equal(g.name, name);
      assert.ok(g.duration > 0 && g.duration === g.frames[g.frames.length - 1].t, name);
      assert.equal(g.frames[0].t, 0);
      for (let i = 1; i < g.frames.length; i++) assert.ok(g.frames[i].t > g.frames[i - 1].t, `${name} ordered`);
      assert.deepEqual(sampleGesture(g, 0), REST, `${name} starts at rest`);
      assert.deepEqual(sampleGesture(g, g.duration), REST, `${name} ends at rest`);
      for (let t = 0; t <= g.duration; t += 16) {
        const o = sampleGesture(g, t);
        for (const key of Object.keys(REST)) assert.ok(Number.isFinite(o[key]), `${name}.${key} at ${t}`);
        for (const key of ['lr', 'rr']) assert.ok(Math.abs(o[key]) <= 1.2, `${name}.${key} ${o[key]}`);
        for (const key of ['lc', 'rc', 'puff', 'lift']) assert.ok(o[key] >= -0.05 && o[key] <= 1.2, `${name}.${key} ${o[key]}`);
        for (const key of ['tilt', 'lflap', 'rflap']) assert.ok(Math.abs(o[key]) <= 12, `${name}.${key} ${o[key]}`);
        assert.ok(Math.abs(o.sway) <= 4, name);
      }
    }
  assert.deepEqual(sampleGesture(null, 100), REST);
});

test('gestures: a new gesture starts from where the last one left off', () => {
  const from = { ...REST, rc: 1, lr: 0.5, sway: 2 };
  const g = gestureFrames('settle', Math.random);
  assert.deepEqual(sampleGesture(g, 0, from), from);
  const mid = sampleGesture(g, g.duration / 2, from);
  assert.ok(mid.rc > 0 && mid.rc < 1);
  assert.deepEqual(sampleGesture(g, g.duration, from), REST);
});

test('gestures: twirls curl the tips into a spiral and back', () => {
  const peak = (g, key) => Math.max(...Array.from({ length: Math.ceil(g.duration / 10) }, (_, i) => sampleGesture(g, i * 10)[key]));
  const peaks = (g, key) => {
    const v = Array.from({ length: Math.ceil(g.duration / 10) }, (_, i) => sampleGesture(g, i * 10)[key]);
    return v.filter((x, i) => i > 0 && i < v.length - 1 && x > v[i - 1] && x >= v[i + 1] && x > 0.6).length;
  };
  // A proud twirl: one random tip (or both) curls up.
  const right = gestureFrames('proud', seq(0.9)), left = gestureFrames('proud', seq(0.4)), both = gestureFrames('proud', seq(0.1));
  assert.ok(peak(right, 'rc') >= 0.9 && peak(right, 'lc') === 0);
  assert.ok(peak(left, 'lc') >= 0.9 && peak(left, 'rc') === 0);
  assert.ok(peak(both, 'lc') >= 0.9 && peak(both, 'rc') >= 0.9);
  // The grand double twirl curls both tips twice.
  const grand = gestureFrames('grandTwirl', Math.random);
  assert.equal(peaks(grand, 'lc'), 2);
  assert.equal(peaks(grand, 'rc'), 2);
  // "Hmm": one tip twirls slowly, the other does not.
  const hmm = gestureFrames('hmm', seq(0.9));
  assert.ok(peak(hmm, 'rc') >= 0.8 && peak(hmm, 'lc') === 0 && hmm.duration >= 2000);
  // "¡Listo!": both tips curl up proudly.
  const listo = gestureFrames('listo', Math.random);
  assert.ok(peak(listo, 'lc') >= 0.7 && peak(listo, 'rc') >= 0.7 && peak(listo, 'lr') > 0.3);
  assert.ok(peak(gestureFrames('puff', Math.random), 'puff') >= 0.9, 'surprise puffs');
  const mamma = gestureFrames('mammamia', Math.random);
  assert.ok(Math.min(...Array.from({ length: 100 }, (_, i) => sampleGesture(mamma, i * mamma.duration / 100).lr)) <= -0.6, 'dramatic droop');
});

test('gestures: a cheeky raise lifts one tip and lowers the other, mirrored per side', () => {
  const a = gestureFrames('cheeky', seq(0.2)), b = gestureFrames('cheeky', seq(0.8));
  assert.equal(a.duration, b.duration);
  for (let t = 0; t <= a.duration; t += 20) {
    const x = sampleGesture(a, t), y = sampleGesture(b, t);
    assert.ok(Math.abs(x.lr - y.rr) < 1e-9 && Math.abs(x.rr - y.lr) < 1e-9 && Math.abs(x.lc - y.rc) < 1e-9);
    assert.ok(Math.abs(x.sway + y.sway) < 1e-9 && Math.abs(x.tilt + y.tilt) < 1e-9);
  }
  const top = sampleGesture(a, a.duration * 0.4);
  assert.ok(top.lr > 0.6 && top.rr < 0, 'one up, one down');
  // Drawn: the left half of one is the mirror image of the right half of the other.
  const pose = { smile: 0.1, curl: 0.15, puff: 0 };
  const l = numbers(moustachePath(-1, moustacheSide(pose, sampleGesture(a, 300), -1)));
  const r = numbers(moustachePath(1, moustacheSide(pose, sampleGesture(b, 300), 1)));
  for (let i = 0; i < l.length; i += 2) assert.ok(Math.abs(l[i] + r[i] - 100) < 0.011 && l[i + 1] === r[i + 1]);
});

test('gestures: shimmy sways side to side; talking is irregular, never a metronome', () => {
  const shimmy = gestureFrames('shimmy', Math.random);
  const sways = shimmy.frames.map(f => f.sway || 0);
  assert.ok(Math.max(...sways) >= 1.5 && Math.min(...sways) <= -1.5);
  const talk = gestureFrames('talk', Math.random), again = gestureFrames('talk', Math.random);
  const gaps = talk.frames.slice(1).map((f, i) => f.t - talk.frames[i].t);
  assert.ok(new Set(gaps).size > 3, `varied syllables: ${gaps}`);
  assert.notDeepEqual(talk.frames, again.frames);
  assert.ok(Math.max(...talk.frames.map(f => f.lift || 0)) > 0.3, 'the lip moves');
  assert.ok(talk.frames.some(f => (f.lflap || 0) !== (f.rflap || 0)), 'the halves move independently');
  // Talking only moves the moustache: its shape stays the mood's, so long replies stay cheap.
  for (const f of talk.frames) for (const key of ['lr', 'rr', 'lc', 'rc', 'puff']) assert.equal(f[key] || 0, 0, key);
});

test('moustache side: pose plus gesture offsets for each half', () => {
  const pose = { smile: -1, curl: 0.2, puff: 0.1 };
  const o = { ...REST, lr: 0.5, rr: -0.5, lc: 0.3, rc: 0.6, puff: 0.2, lift: 0.4 };
  assert.deepEqual(moustacheSide(pose, o, -1), { raise: -0.5, curl: 0.5, puff: 0.30000000000000004 });
  assert.deepEqual(moustacheSide(pose, o, 1), { raise: -1.5, curl: 0.8, puff: 0.30000000000000004 });
  assert.deepEqual(moustacheSide(pose, null, 1), { raise: -1, curl: 0.2, puff: 0.1 });
});

test('random delays stay within their range', () => {
  assert.equal(nextDelay([10000, 20000], () => 0), 10000);
  assert.equal(nextDelay([10000, 20000], () => 0.5), 15000);
  assert.ok(nextDelay([10000, 20000], () => 0.999999) <= 20000);
  assert.equal(nextDelay(null, () => 0.5), 0);
});

test('sleep: due exactly N minutes after the last activity, never with 0, reset by activity', () => {
  const minute = 60000, last = 1_000_000;
  const due = (now, extra) => sleepDue({ now, lastActivity: last, minutes: 30, ...extra });
  assert.equal(due(last), false);
  assert.equal(due(last + 30 * minute - 1), false, 'one millisecond before');
  assert.equal(due(last + 30 * minute), true, 'exactly 30 minutes');
  assert.equal(due(last + 3 * 60 * minute), true);
  assert.equal(due(last + 15 * minute, { minutes: 15 }), true);
  assert.equal(due(last + 15 * minute - 1, { minutes: 15 }), false);
  // 0 (or anything not a positive number) never sleeps.
  for (const minutes of [0, -5, NaN, undefined, null, 'x'])
    assert.equal(due(last + 365 * 24 * 60 * minute, { minutes }), false, String(minutes));
  // Activity moves the start: 29 minutes after a later activity is still awake.
  assert.equal(sleepDue({ now: last + 59 * minute, lastActivity: last + 30 * minute, minutes: 30 }), false);
  assert.equal(sleepDue({ now: last + 60 * minute, lastActivity: last + 30 * minute, minutes: 30 }), true);
  // Something in progress (the agent working, a question waiting, dictation, an upload) keeps it awake.
  assert.equal(due(last + 120 * minute, { engaged: true }), false);
  // No usable timestamps: awake.
  assert.equal(sleepDue({ now: NaN, lastActivity: last, minutes: 30 }), false);
  assert.equal(sleepDue({ now: last, lastActivity: undefined, minutes: 30 }), false);
  assert.equal(sleepDue(null), false);
});

test('sleep: the minutes setting defaults to 30, 0 turns it off, bad values fall back', () => {
  assert.equal(sleepMinutes(undefined), 30);
  assert.equal(sleepMinutes(null), 30);
  assert.equal(sleepMinutes('nope'), 30);
  assert.equal(sleepMinutes(-1), 30);
  assert.equal(sleepMinutes(0), 0);
  assert.equal(sleepMinutes(15), 15);
  assert.equal(sleepMinutes('60'), 60);
  assert.equal(sleepMinutes(12.6), 13);
  assert.equal(sleepMinutes(99999), 1440);
});

test('sleep priority: above typing and idle, below needs you, voice, uploads and errors; disconnected keeps its own look', () => {
  assert.equal(at({ asleep: true }), 'asleep');
  assert.equal(at({ asleep: true, typing: true }), 'asleep');
  assert.equal(at({ asleep: true, agentState: 'needs_you' }), 'alert');
  assert.equal(at({ asleep: true, asks: 1 }), 'alert');
  assert.equal(at({ asleep: true, voice: 'recording' }), 'listening');
  assert.equal(at({ asleep: true, voice: 'transcribing' }), 'pondering');
  assert.equal(at({ asleep: true, uploading: true }), 'busy');
  assert.equal(at({ asleep: true, error: true }), 'worried');
  assert.equal(at({ asleep: true, agentState: 'error' }), 'worried');
  // Disconnected (or not connected yet) wins over sleep: one sleepy look, never two fighting.
  assert.equal(mood({ connection: 'fatal', asleep: true }), 'sleepy');
  assert.equal(mood({ connection: 'stopped', asleep: true }), 'sleepy');
  assert.equal(mood({ connection: 'reconnecting', asleep: true }), 'searching');
  // Waking up: the short reaction shows over typing and idle, never over a question or an error.
  assert.equal(at({ reaction: 'waking' }), 'waking');
  assert.equal(at({ reaction: 'waking', typing: true }), 'waking');
  assert.equal(at({ reaction: 'waking', asks: 1 }), 'alert');
  assert.equal(at({ reaction: 'waking', error: true }), 'worried');
  assert.equal(mood({ connection: 'fatal', reaction: 'waking' }), 'sleepy');
  // A click on an awake avatar is still happy; a click never shows while asleep (it wakes instead).
  assert.equal(at({ reaction: 'happy', asleep: true }), 'happy');
});

test('sleep look: shut eyes, z letters, slow breathing, a dozing moustache; waking stretches', () => {
  assert.ok(MOODS.includes('asleep') && MOODS.includes('waking'));
  const asleep = expression('asleep');
  assert.equal(asleep.eyes, 'closed');
  assert.equal(asleep.open, 0);
  assert.equal(asleep.follow, false);
  assert.equal(asleep.extra, 'zzz');
  assert.equal(asleep.motion, 'sleep');
  assert.ok(asleep.smile < 0, 'drooping tips');
  assert.deepEqual(moustacheGestures('asleep'), { every: [3000, 5500], gesture: 'snooze' });
  // Disconnected keeps its single drifting z and its doze.
  assert.equal(expression('sleepy').extra, 'z');
  assert.equal(moustacheGestures('sleepy').gesture, 'doze');
  const waking = expression('waking');
  assert.equal(waking.eyes, 'open');
  assert.ok(waking.open > 0.5 && waking.extra === '');
  assert.equal(moustacheGestures('waking').entry, 'wakeup');
});

test('sleep gestures: snooze droops slowly, sometimes snores or twitches, moves only; wakeup stretches then shakes', () => {
  const peak = (g, key, f = Math.max) => {
    let best = 0;
    for (let t = 0; t <= g.duration; t += 10) best = f(best, sampleGesture(g, t)[key]);
    return best;
  };
  for (const r of [0, 0.35, 0.45, 0.9]) {
    const g = gestureFrames('snooze', () => r);
    assert.ok(g.duration >= 2500, 'slow');
    assert.ok(peak(g, 'rflap', Math.min) < -5 && peak(g, 'lflap', Math.min) < -5, 'both halves sag');
    // Moves only: the outline is never rebuilt while it sleeps.
    for (const key of ['lr', 'rr', 'lc', 'rc', 'puff'])
      assert.ok(g.frames.every(f => !f[key]), `snooze changes no shape (${key})`);
  }
  assert.ok(peak(gestureFrames('snooze', () => 0), 'lift') > 0.6, 'a snore blows it up');
  assert.ok(peak(gestureFrames('snooze', () => 0.9), 'lift') === 0, 'mostly just a droop');
  for (const r of [0.35, 0.45]) {
    const twitch = gestureFrames('snooze', () => r);
    assert.ok(twitch.frames.some(f => Math.abs((f.lflap || 0) - (f.rflap || 0)) > 8), 'one tip twitches');
  }
  assert.notDeepEqual(gestureFrames('snooze', () => 0.35).frames, gestureFrames('snooze', () => 0.45).frames, 'either side');
  const wake = gestureFrames('wakeup', () => 0.5);
  assert.ok(wake.duration <= 1400, 'short');
  assert.ok(peak(wake, 'puff') > 0.4 && peak(wake, 'rr') > 0.5, 'a stretch: puffed, tips up');
  assert.ok(peak(wake, 'sway') > 1.5 && peak(wake, 'sway', Math.min) < -1.5, 'a shake');
});
