import test from 'node:test';
import assert from 'node:assert/strict';
import { label, activityLabel, phaseOf, PHASES } from '../status.mjs';

const open = { connection: 'open', ready: true, agentState: 'idle', asks: 0, voice: 'idle', uploading: false };
const busy = Object.assign({}, open, { agentState: 'working' });
const run = (activity) => Object.assign({ id: 'a1', status: 'running' }, activity);

test('status: idle is "ready", dim', () => {
  assert.deepEqual(label(open), { text: 'ready', tone: 'dim' });
  assert.deepEqual(label({ connection: 'open', ready: true }), { text: 'ready', tone: 'dim' });
});

test('status: connection states come first', () => {
  for (const connection of ['fatal', 'stopped', '', undefined])
    assert.deepEqual(label(Object.assign({}, busy, { connection, asks: 2 })), { text: 'offline', tone: 'urgent' }, String(connection));
  assert.deepEqual(label(Object.assign({}, busy, { connection: 'reconnecting', ready: false, asks: 1 })),
    { text: 'reconnecting…', tone: 'urgent' });
  assert.deepEqual(label(Object.assign({}, open, { connection: 'connecting', ready: false })), { text: 'connecting…', tone: 'dim' });
  assert.deepEqual(label(Object.assign({}, open, { ready: false })), { text: 'connecting…', tone: 'dim' });
  assert.deepEqual(label(null), { text: 'offline', tone: 'urgent' });
});

test('status: a pending ask or needs_you is "waiting for you", above voice, uploads and activities', () => {
  const waiting = { text: 'waiting for you', tone: 'urgent' };
  assert.deepEqual(label(Object.assign({}, open, { asks: 1 })), waiting);
  assert.deepEqual(label(Object.assign({}, open, { agentState: 'needs_you' })), waiting);
  assert.deepEqual(label(Object.assign({}, busy, { asks: 1, voice: 'recording', uploading: true,
    activity: run({ kind: 'run' }), phase: 'implementing', streaming: true })), waiting);
});

test('status: recording, transcribing and uploading beat the running activity', () => {
  const activity = run({ kind: 'run' });
  assert.deepEqual(label(Object.assign({}, busy, { voice: 'recording', uploading: true, activity })), { text: 'recording', tone: 'accent' });
  assert.deepEqual(label(Object.assign({}, open, { voice: 'loading' })), { text: 'recording', tone: 'accent' });
  assert.deepEqual(label(Object.assign({}, busy, { voice: 'transcribing', uploading: true, activity })), { text: 'transcribing', tone: 'accent' });
  assert.deepEqual(label(Object.assign({}, open, { voice: 'cancelling' })), { text: 'transcribing', tone: 'accent' });
  assert.deepEqual(label(Object.assign({}, busy, { uploading: true, activity })), { text: 'uploading', tone: 'accent' });
});

test('status: old-daemon activities fall back to their kind and title', () => {
  const cases = [
    [{ kind: 'memory', title: 'Checking my notes' }, 'reading memory'],
    [{ kind: 'memory', title: 'Saving a note' }, 'saving a note'],
    [{ kind: 'run', title: 'Running a command' }, 'running command'],
    [{ kind: 'read', title: 'Reading Composer.qml' }, 'reading files'],
    [{ kind: 'edit', title: 'Editing Composer.qml' }, 'editing'],
    [{ kind: 'search', title: 'Searching files' }, 'exploring'],
    [{ kind: 'search', title: 'Looking things up online' }, 'searching the web'],
    [{ kind: 'delegate', title: 'Asking a helper' }, 'delegating'],
    [{ kind: 'other', title: 'Working' }, 'working'],
    [{ kind: 'something-new', title: 'Whatever' }, 'working'],
    [{}, 'working']
  ];
  for (const [activity, text] of cases) {
    assert.equal(activityLabel(activity), text, JSON.stringify(activity));
    assert.deepEqual(label(Object.assign({}, busy, { activity: run(activity) })), { text, tone: 'accent' }, JSON.stringify(activity));
  }
});

test('status: patched-daemon activities use their tool and source', () => {
  const cases = [
    [{ kind: 'memory', tool: 'mem_search', source: 'engram' }, 'reading memory'],
    [{ kind: 'memory', tool: 'mem_get_observation', source: 'engram' }, 'reading memory'],
    [{ kind: 'memory', tool: 'mem_save', source: 'engram' }, 'saving a note'],
    [{ kind: 'memory', tool: 'mem_save_prompt', source: 'engram' }, 'saving a note'],
    [{ kind: 'memory', tool: 'mem_update', source: 'engram' }, 'saving a note'],
    [{ kind: 'memory', tool: 'mem_session_summary', source: 'engram' }, 'saving a note'],
    [{ kind: 'run', tool: 'bash', source: 'shell' }, 'running command'],
    [{ kind: 'other', tool: 'bash_background', source: 'shell' }, 'running command'],
    [{ kind: 'read', tool: 'read', source: 'files' }, 'reading files'],
    [{ kind: 'edit', tool: 'edit', source: 'files' }, 'editing'],
    [{ kind: 'edit', tool: 'write', source: 'files' }, 'editing'],
    [{ kind: 'search', tool: 'grep', source: 'files' }, 'exploring'],
    [{ kind: 'search', tool: 'find', source: 'files' }, 'exploring'],
    [{ kind: 'other', tool: 'codegraph_search', source: 'files' }, 'exploring'],
    [{ kind: 'search', tool: 'web_search', source: 'web' }, 'searching the web'],
    [{ kind: 'search', tool: 'fetch_content', source: 'web' }, 'searching the web'],
    [{ kind: 'delegate', tool: 'subagent_run', source: 'subagent' }, 'delegating'],
    [{ kind: 'other', tool: 'gentle_review_run', source: 'rdd' }, 'reviewing'],
    [{ kind: 'other', tool: 'mcp__slack__post', source: 'slack' }, 'checking Slack'],
    [{ kind: 'other', tool: 'mcp__linear__list', source: 'linear' }, 'checking Linear'],
    [{ kind: 'other', tool: 'mcp__gmail__search', source: 'gmail' }, 'checking Gmail'],
    [{ kind: 'other', tool: 'mcp__notion__fetch', source: 'notion' }, 'checking Notion'],
    [{ kind: 'other', tool: 'mcp__atlassian__jira', source: 'atlassian' }, 'checking Atlassian'],
    [{ kind: 'other', tool: 'mcp__discord__read', source: 'discord' }, 'checking Discord'],
    [{ kind: 'other', tool: 'mcp__figma__file', source: 'mcp' }, 'using a connector'],
    [{ kind: 'other', tool: 'something', source: 'other' }, 'working'],
    // A source this client does not know yet falls back to the kind.
    [{ kind: 'run', tool: 'future', source: 'future-source' }, 'running command']
  ];
  for (const [activity, text] of cases) {
    assert.equal(activityLabel(activity), text, JSON.stringify(activity));
    assert.deepEqual(label(Object.assign({}, busy, { activity: run(activity) })), { text, tone: 'accent' }, JSON.stringify(activity));
  }
});

test('status: raw tool arguments, titles and outputs never reach the label', () => {
  const activity = run({ kind: 'read', tool: 'read', source: 'files', title: 'Reading secret-host.tailnet-example.ts.net.txt',
    detail: '{"path":"/home/me/100.64.0.42/token","phase":"implementing"}', output: 'wss://host/ws' });
  assert.equal(label(Object.assign({}, busy, { activity })).text, 'reading files');
  // A non-phase tool whose arguments mention a phase does not set one.
  assert.equal(phaseOf(activity), '');
  assert.equal(phaseOf(run({ tool: 'gentle_odd_phase', detail: '{"phase":"rm -rf /"}' })), '');
  assert.equal(phaseOf(run({ tool: 'gentle_odd_phase', detail: '{"phase":"wss://host.ts.net"}' })), '');
});

test('status: gentle_odd_phase announces the phase from its detail or title', () => {
  assert.deepEqual(PHASES, ['authorizing', 'exploring', 'researching', 'deciding', 'planning', 'implementing', 'checking', 'closing']);
  for (const phase of PHASES) {
    assert.equal(phaseOf({ tool: 'gentle_odd_phase', detail: JSON.stringify({ phase }) }), phase);
    assert.equal(phaseOf({ tool: 'gentle_odd_phase', detail: { phase } }), phase);
  }
  assert.equal(phaseOf({ tool: 'gentle_odd_phase', detail: '{"phase":"clear"}' }), 'clear');
  assert.equal(phaseOf({ tool: 'gentle_odd_phase', detail: '{"phase": "Implementing"}' }), 'implementing');
  // A preview cut at 200 characters is no longer JSON; the phase is still read.
  assert.equal(phaseOf({ tool: 'gentle_odd_phase', detail: '{"phase":"checking","note":"' + 'x'.repeat(200) + '…' }), 'checking');
  // An MCP-prefixed name of the same tool.
  assert.equal(phaseOf({ tool: 'mcp__gentle__gentle_odd_phase', detail: '{"phase":"planning"}' }), 'planning');
  // Title only (no tool/detail): a gentle_odd_phase title that carries the phase.
  assert.equal(phaseOf({ kind: 'other', title: 'gentle_odd_phase: deciding' }), 'deciding');
  assert.equal(phaseOf({ kind: 'other', title: 'ODD phase · researching' }), 'researching');
  assert.equal(phaseOf({ kind: 'other', title: 'ODD phase · clear' }), 'clear');
  // Anything else is not a phase announcement.
  assert.equal(phaseOf({ kind: 'other', title: 'Working' }), '');
  assert.equal(phaseOf({ kind: 'search', title: 'Searching files: implementing' }), '');
  assert.equal(phaseOf({ tool: 'gentle_odd_phase' }), '');
  assert.equal(phaseOf(null), '');
});

test('status: the ODD phase shows while busy, below the running activity', () => {
  const activity = run({ kind: 'run', tool: 'bash', source: 'shell' });
  assert.deepEqual(label(Object.assign({}, busy, { phase: 'implementing' })), { text: 'implementing', tone: 'accent' });
  assert.deepEqual(label(Object.assign({}, open, { agentState: 'thinking', phase: 'exploring' })), { text: 'exploring', tone: 'accent' });
  assert.deepEqual(label(Object.assign({}, open, { streaming: true, phase: 'checking' })), { text: 'checking', tone: 'accent' });
  assert.deepEqual(label(Object.assign({}, busy, { phase: 'implementing', activity })), { text: 'running command', tone: 'accent' });
  // Not busy: no phase.
  assert.deepEqual(label(Object.assign({}, open, { phase: 'implementing' })), { text: 'ready', tone: 'dim' });
  // "clear", an unknown or empty phase shows nothing.
  for (const phase of ['clear', 'bogus', '', undefined])
    assert.deepEqual(label(Object.assign({}, open, { agentState: 'thinking', phase })), { text: 'thinking', tone: 'accent' }, String(phase));
});

test('status: answering, thinking and the remaining agent states', () => {
  assert.deepEqual(label(Object.assign({}, open, { agentState: 'thinking' })), { text: 'thinking', tone: 'accent' });
  // The daemon stays "thinking" while the reply streams: deltas flowing read as answering.
  assert.deepEqual(label(Object.assign({}, open, { agentState: 'thinking', streaming: true })), { text: 'answering', tone: 'accent' });
  assert.deepEqual(label(Object.assign({}, open, { streaming: true })), { text: 'answering', tone: 'accent' });
  assert.deepEqual(label(Object.assign({}, open, { agentState: 'working' })), { text: 'working', tone: 'accent' });
  assert.deepEqual(label(Object.assign({}, open, { agentState: 'starting' })), { text: 'starting…', tone: 'dim' });
  assert.deepEqual(label(Object.assign({}, open, { agentState: 'restarting' })), { text: 'starting…', tone: 'dim' });
  assert.deepEqual(label(Object.assign({}, open, { agentState: 'error' })), { text: 'error', tone: 'urgent' });
});

// The composer's border label is the one place that says what the assistant is doing:
// the panel no longer repeats it as a pulsing caption above the composer.
test('panel: no busy caption duplicating the status label', async () => {
  const { readFile } = await import('node:fs/promises');
  const panel = await readFile(new URL('../Panel.qml', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /root\.agentLabel\(\) \+ "…"/);
});
