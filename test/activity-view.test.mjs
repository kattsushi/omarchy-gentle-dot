import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrich, parseLoose, view, withView } from '../bridge/activity-view.mjs';

const highlighted = /<span style="color:#[a-fA-F0-9]{6}">/;
const shell = (detail, output, extra = {}) => view({ id: 'a', kind: 'run', title: 'Ran a command', status: 'done', tool: 'bash', source: 'shell', detail, output, ...extra });

test('shell commands render as highlighted bash, other arguments as fields, output as terminal text', () => {
  const { detail, output } = shell('{"command":"ls -d ~/x | head -3","timeout":30,"cwd":"/tmp"}', '\x1b[1;31mred\x1b[0m\r\nplain \x1b]0;title\x07done\n');
  assert.equal(detail.type, 'code');
  assert.equal(detail.lang, 'bash');
  assert.equal(detail.code, 'ls -d ~/x | head -3');
  assert.match(detail.html, highlighted);
  assert.deepEqual(detail.extra, [{ key: 'timeout', value: '30' }, { key: 'cwd', value: '/tmp' }]);
  assert.deepEqual(output, { type: 'terminal', text: 'red\nplain done' });
});

test('shell output keeps "(no output)" for empty results and has no view while running', () => {
  assert.deepEqual(shell('{"command":"true"}', '').output, { type: 'terminal', text: '(no output)' });
  assert.deepEqual(shell('{"command":"true"}', '  \n').output, { type: 'terminal', text: '(no output)' });
  assert.deepEqual(shell('{"command":"true"}', '(no output)').output, { type: 'terminal', text: '(no output)' });
  assert.equal(shell('{"command":"sleep 1"}', undefined, { status: 'running' }).output, null);
  assert.equal(shell('{"command":"true"}').detail.extra, undefined);
});

test('every shell tool maps the same way; a command without JSON is still bash', () => {
  for (const tool of ['bash_background', 'monitor', 'job_start']) {
    const { detail } = view({ tool, kind: 'other', detail: '{"command":"npm test","name":"tests"}' });
    assert.equal(detail.type, 'code', tool);
    assert.equal(detail.code, 'npm test', tool);
    assert.deepEqual(detail.extra, [{ key: 'name', value: 'tests' }], tool);
  }
  assert.deepEqual(view({ tool: 'job_status', detail: '{"id":"j1"}' }).detail, { type: 'fields', items: [{ key: 'id', value: 'j1' }] });
  const plain = view({ tool: 'bash', detail: 'echo hi' }).detail;
  assert.equal(plain.type, 'code');
  assert.equal(plain.code, 'echo hi');
});

test('a command cut inside its string keeps the text with a trailing ellipsis', () => {
  const { detail } = shell('{"command":"find . -name \\"*.qml\\" | xargs grep -n Activ');
  assert.equal(detail.type, 'code');
  assert.equal(detail.code, 'find . -name "*.qml" | xargs grep -n Activ…');
  assert.equal(detail.extra, undefined);
});

test('redaction markers stay visible as they are', () => {
  const { detail, output } = shell('{"command":"curl -H \\"Authorization: Bearer [REDACTED]\\" https://example.test","token":"[REDACTED]","[TRUNCATED]":"[TRUNCATED]"}', 'key=[REDACTED] ok[TRUNCATED]');
  assert.equal(detail.code, 'curl -H "Authorization: Bearer [REDACTED]" https://example.test');
  assert.match(detail.html, /\[REDACTED\]/);
  assert.deepEqual(detail.extra, [{ key: 'token', value: '[REDACTED]' }, { key: '[TRUNCATED]', value: '[TRUNCATED]' }]);
  assert.equal(output.text, 'key=[REDACTED] ok[TRUNCATED]');
  const mcp = view({ tool: 'mcp__gmail__read', source: 'gmail', detail: '{"subject":"Your code","body":"[REDACTED]"}' });
  assert.deepEqual(mcp.detail.items, [{ key: 'subject', value: 'Your code' }, { key: 'body', value: '[REDACTED]' }]);
});

const observations = [
  { id: 7, title: 'Fixed the bridge', type: 'bugfix', project: 'omarchy-gentle-dot', created_at: '2026-10-28 14:05:00', content: 'What: ...' },
  { id: 8, type: 'decision', project: 'gentle-dot', created_at: '2026-10-27T09:00:00Z', content: 'Keep protocol v1\nbecause clients...' },
  { id: 9, content: 'Bare note' },
];

test('memory searches show the query and filters as fields and observations as a compact list', () => {
  for (const tool of ['mem_search', 'mem_context', 'mem_timeline', 'mem_get_observation']) {
    const { detail } = view({ tool, source: 'engram', kind: 'memory', detail: '{"limit":5,"query":"gentle dot","project":"omarchy","type":"decision"}' });
    assert.deepEqual(detail, { type: 'fields', items: [
      { key: 'query', value: 'gentle dot' }, { key: 'limit', value: '5' }, { key: 'project', value: 'omarchy' }, { key: 'type', value: 'decision' },
    ] }, tool);
  }
  const { output } = view({ tool: 'mem_search', detail: '{"query":"x"}', output: JSON.stringify(observations) });
  assert.deepEqual(output, { type: 'list', items: [
    { title: 'Fixed the bridge', meta: 'bugfix · omarchy-gentle-dot · 2026-10-28' },
    { title: 'Keep protocol v1', meta: 'decision · gentle-dot · 2026-10-27' },
    { title: 'Bare note' },
  ] });
  const wrapped = view({ tool: 'mem_search', output: JSON.stringify({ results: observations.slice(0, 1) }) }).output;
  assert.deepEqual(wrapped.items, [{ title: 'Fixed the bridge', meta: 'bugfix · omarchy-gentle-dot · 2026-10-28' }]);
});

test('a memory result list cut inside the array shows the whole observations and "+N more"', () => {
  const full = JSON.stringify(observations);
  const cut = full.slice(0, full.indexOf('Keep protocol') + 4);
  const { output } = view({ tool: 'mem_search', output: cut });
  assert.deepEqual(output, { type: 'list', items: [{ title: 'Fixed the bridge', meta: 'bugfix · omarchy-gentle-dot · 2026-10-28' }], more: 1, cut: true });
  const between = view({ tool: 'mem_search', output: full.slice(0, full.indexOf('{"id":8') + 1) }).output;
  assert.deepEqual(between.items.length, 1);
  assert.equal(between.more, 1);
  const marker = view({ tool: 'mem_search', output: JSON.stringify([observations[0], '[TRUNCATED]']) }).output;
  assert.deepEqual(marker.items.map(item => item.title), ['Fixed the bridge', '[TRUNCATED]']);
  const many = view({ tool: 'mem_search', output: JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ title: `n${i}` }))) }).output;
  assert.equal(many.items.length, 8);
  assert.equal(many.more, 3);
  assert.equal(many.cut, undefined);
});

test('memory output that is not a list of observations stays text', () => {
  assert.deepEqual(view({ tool: 'mem_search', output: 'Found 2 memories:\n[1] #7 (bugfix) Fixed' }).output, { type: 'text', text: 'Found 2 memories:\n[1] #7 (bugfix) Fixed' });
  assert.deepEqual(view({ tool: 'mem_search', output: '[]' }).output, { type: 'text', text: 'No results' });
});

test('saving a note shows title, type and topic key as fields and the first lines of the content', () => {
  const content = 'What: one\nWhy: two\nWhere: three\nLearned: four\nfive\nsix\nseven';
  for (const tool of ['mem_save', 'mem_update', 'mem_session_summary']) {
    const { detail, output } = view({ tool, source: 'engram', kind: 'memory', detail: JSON.stringify({ content, topic_key: 'bug/x', type: 'bugfix', title: 'Fixed X', project: 'p' }), output: 'Saved #12' });
    assert.deepEqual(detail, { type: 'fields', items: [
      { key: 'title', value: 'Fixed X' }, { key: 'type', value: 'bugfix' }, { key: 'topic_key', value: 'bug/x' }, { key: 'project', value: 'p' },
    ], text: 'What: one\nWhy: two\nWhere: three\nLearned: four\nfive\n…' }, tool);
    assert.deepEqual(output, { type: 'text', text: 'Saved #12' });
  }
  const cut = view({ tool: 'mem_save', detail: '{"title":"T","content":"Short but cu' }).detail;
  assert.deepEqual(cut, { type: 'fields', items: [{ key: 'title', value: 'T' }], text: 'Short but cu…' });
});

test('file tools show their path; read output is code in the language of the file', () => {
  const read = view({ tool: 'read', source: 'files', kind: 'read', detail: '{"path":"/src/app.ts","offset":10}', output: 'const a: number = 1;' });
  assert.deepEqual(read.detail, { type: 'path', path: '/src/app.ts', extra: [{ key: 'offset', value: '10' }] });
  assert.equal(read.output.type, 'code');
  assert.equal(read.output.lang, 'typescript');
  assert.equal(read.output.code, 'const a: number = 1;');
  assert.match(read.output.html, highlighted);
  for (const [file, lang] of [['a.py', 'python'], ['b.rs', 'rust'], ['Dockerfile', 'dockerfile'], ['c.yml', 'yaml'], ['d.sh', 'bash'], ['e.mjs', 'javascript'], ['f.json', 'json']])
    assert.equal(view({ tool: 'read', detail: JSON.stringify({ file_path: file }), output: 'x' }).output.lang, lang, file);
  assert.deepEqual(view({ tool: 'read', detail: '{"filePath":"notes.qml"}', output: 'Item {}' }).output, { type: 'text', text: 'Item {}' });
  assert.deepEqual(view({ tool: 'grep', detail: '{"pattern":"TODO","path":"src"}', output: 'src/a:1: TODO' }), {
    detail: { type: 'path', path: 'src', extra: [{ key: 'pattern', value: 'TODO' }] }, output: { type: 'text', text: 'src/a:1: TODO' },
  });
  assert.deepEqual(view({ tool: 'find', detail: '{"pattern":"*.qml"}' }).detail, { type: 'path', path: '*.qml' });
  assert.deepEqual(view({ tool: 'codegraph_search', detail: '{"glob":"src/**"}' }).detail, { type: 'path', path: 'src/**' });
});

test('edits show the path and a small diff when the arguments carry one', () => {
  const edit = view({ tool: 'edit', kind: 'edit', detail: '{"path":"a.py","edits":[{"oldText":"x = 1","newText":"x = 2\\ny = 3"}]}', output: 'Applied 1 edit' });
  assert.equal(edit.detail.type, 'path');
  assert.equal(edit.detail.path, 'a.py');
  assert.equal(edit.detail.extra, undefined);
  assert.equal(edit.detail.code.lang, 'diff');
  assert.equal(edit.detail.code.code, '-x = 1\n+x = 2\n+y = 3');
  assert.match(edit.detail.code.html, highlighted);
  assert.deepEqual(edit.output, { type: 'text', text: 'Applied 1 edit' });
  assert.equal(view({ tool: 'edit', detail: '{"file_path":"b.ts","old_string":"a","new_string":"b"}' }).detail.code.code, '-a\n+b');
  assert.equal(view({ tool: 'edit', detail: '{"path":"c.ts","diff":"@@ -1 +1 @@\\n-a\\n+b"}' }).detail.code.code, '@@ -1 +1 @@\n-a\n+b');
  const cut = view({ tool: 'edit', detail: '{"path":"a.py","edits":[{"oldText":"x = 1","newText":"x = ' }).detail;
  assert.equal(cut.code.code, '-x = 1\n+x = …');
  assert.deepEqual(view({ tool: 'edit', detail: '{"path":"a.py"}' }).detail, { type: 'path', path: 'a.py' });
  const write = view({ tool: 'write', detail: '{"path":"w.py","content":"print(1)"}' }).detail;
  assert.equal(write.code.lang, 'python');
  assert.equal(write.code.code, 'print(1)');
});

test('web tools show the query as fields and a URL as a path; output is text', () => {
  assert.deepEqual(view({ tool: 'web_search', source: 'web', detail: '{"query":"qt loader","numResults":3}', output: '1. Loader' }), {
    detail: { type: 'fields', items: [{ key: 'query', value: 'qt loader' }, { key: 'numResults', value: '3' }] },
    output: { type: 'text', text: '1. Loader' },
  });
  assert.deepEqual(view({ tool: 'fetch_content', detail: '{"url":"https://example.test/a?x=1","maxChars":500}' }).detail,
    { type: 'path', path: 'https://example.test/a?x=1', extra: [{ key: 'maxChars', value: '500' }] });
  assert.deepEqual(view({ tool: 'source_check', detail: '{"urls":["https://a.test","https://b.test"]}' }).detail,
    { type: 'fields', items: [{ key: 'urls', value: '["https://a.test","https://b.test"]' }] });
});

test('subagents show agent, label and task as fields; output is text', () => {
  assert.deepEqual(view({ tool: 'subagent_run', source: 'subagent', detail: '{"task":"Implement T35","extra":1,"agent":"gentle-ai-worker","label":"T35"}', output: 'done' }), {
    detail: { type: 'fields', items: [
      { key: 'agent', value: 'gentle-ai-worker' }, { key: 'label', value: 'T35' }, { key: 'task', value: 'Implement T35' }, { key: 'extra', value: '1' },
    ] },
    output: { type: 'text', text: 'done' },
  });
});

test('connectors and other tools show one level of fields and pretty JSON output', () => {
  for (const [tool, source] of [['mcp__slack__post', 'slack'], ['mcp__linear__get', 'linear'], ['mcp__notion__x', 'notion'], ['mcp__atlassian__y', 'atlassian'], ['mcp__discord__z', 'discord'], ['gentle_review_run', 'rdd'], ['mcp__any__tool', 'mcp'], ['ask_user', 'other']]) {
    const { detail, output } = view({ tool, source, kind: 'other', detail: '{"channel":"C1","blocks":[{"a":1}],"opts":{"x":true},"n":null}', output: '{"ok":true,"ts":"1"}' });
    assert.deepEqual(detail, { type: 'fields', items: [
      { key: 'channel', value: 'C1' }, { key: 'blocks', value: '[{"a":1}]' }, { key: 'opts', value: '{"x":true}' }, { key: 'n', value: 'null' },
    ] }, tool);
    assert.equal(output.type, 'code', tool);
    assert.equal(output.lang, 'json');
    assert.equal(output.code, '{\n  "ok": true,\n  "ts": "1"\n}');
    assert.match(output.html, highlighted);
  }
  const plain = view({ tool: 'mcp__slack__post', detail: 'not json', output: 'Posted.' });
  assert.deepEqual(plain, { detail: { type: 'text', text: 'not json' }, output: { type: 'text', text: 'Posted.' } });
  assert.deepEqual(view({ tool: 'mcp__x__y', output: '{"ok":tr' }).output, { type: 'text', text: '{"ok":tr' });
  assert.deepEqual(view({ tool: 'mcp__x__y', output: '42' }).output, { type: 'text', text: '42' });
});

test('an unknown tool falls back to the source, then the kind, then generic fields', () => {
  assert.equal(view({ tool: 'weird_tool', detail: '{"command":"ls"}' }).detail.type, 'fields');
  assert.equal(view({ source: 'shell', detail: '{"command":"ls"}' }).detail.type, 'code');
  assert.equal(view({ kind: 'run', detail: '{"command":"ls"}' }).detail.type, 'code');
  assert.equal(view({ kind: 'memory', output: JSON.stringify(observations) }).output.type, 'list');
  assert.equal(view({ kind: 'memory', detail: '{"title":"T","content":"c"}' }).detail.text, 'c');
  assert.equal(view({ kind: 'read', detail: '{"path":"a.go"}', output: 'package a' }).output.lang, 'go');
  assert.equal(view({ kind: 'edit', detail: '{"path":"a","oldText":"1","newText":"2"}' }).detail.code.code, '-1\n+2');
  assert.equal(view({ kind: 'delegate', detail: '{"task":"t","agent":"a"}' }).detail.items[0].key, 'agent');
  assert.deepEqual(view({ kind: 'other', detail: '{"a":1}' }).detail, { type: 'fields', items: [{ key: 'a', value: '1' }] });
  assert.deepEqual(view({ kind: 'other', detail: '[1,2]' }).detail, { type: 'text', text: '[1,2]' });
});

test('empty or missing detail and output have no view', () => {
  assert.deepEqual(view({ tool: 'read', detail: '', output: '' }), { detail: null, output: null });
  assert.deepEqual(view({ kind: 'other' }), { detail: null, output: null });
  assert.deepEqual(view({}), { detail: null, output: null });
});

test('the forgiving parser recovers top-level fields from cut JSON and never throws', () => {
  assert.deepEqual(parseLoose('{"n":12,"ok":true,"no":false,"z":null,"s":"abc').value, { n: 12, ok: true, no: false, z: null, s: 'abc…' });
  assert.equal(parseLoose('{"n":12,"ok":true,"s":"abc').cut, true);
  assert.equal(parseLoose('{"n":12}').cut, false);
  assert.deepEqual(parseLoose('{"a":"x\\"y\\n\\u00e9","b":').value, { a: 'x"y\né' });
  assert.deepEqual(parseLoose('{"a":tr').value, {});
  assert.deepEqual(parseLoose('{"a":1,"b').value, { a: 1 });
  assert.deepEqual(parseLoose('{"a":"\\u00').value, { a: '…' });
  assert.deepEqual(parseLoose('{"a":"end\\').value, { a: 'end…' });
  assert.deepEqual(parseLoose('{"a":{"b":1},"c":[1,2').value, { a: { b: 1 }, c: [1, 2] });
  assert.equal(parseLoose('{bad json}').ok, false);
  assert.equal(parseLoose('plain text').ok, false);
  for (const input of ['', '{', '[', '{"', '{"a":', '{"a" 1}', '[1,,', '{"a":-', '{"a":1e', '}', '[{"a":[{"b":"', '"str', null, undefined, 42, {}])
    assert.doesNotThrow(() => { parseLoose(input); view({ tool: 'bash', detail: input, output: input }); view({ tool: 'mem_search', detail: input, output: input }); view({ detail: input, output: input }); }, String(input));
});

test('the bridge adds a view to live, history and earlier activities and keeps the raw fields', () => {
  const activity = { id: 'a', kind: 'run', title: 'Ran a command', status: 'done', tool: 'bash', source: 'shell', detail: '{"command":"ls"}', output: 'a\nb' };
  const live = enrich({ type: 'activity', messageId: 'm', activity });
  assert.deepEqual(live, { type: 'activity', messageId: 'm', activity: { ...activity, view: view(activity) } });
  assert.equal(live.activity.view.detail.code, 'ls');
  for (const type of ['history', 'earlier']) {
    const frame = enrich({ type, messages: [{ id: 'u', role: 'user', text: 'hi' }, { id: 'm', role: 'assistant', text: 'ok', activities: [activity, { id: 'b', kind: 'other', title: 'Old' }] }] });
    assert.deepEqual(frame.messages[0], { id: 'u', role: 'user', text: 'hi' }, type);
    assert.deepEqual(frame.messages[1].activities, [{ ...activity, view: view(activity) }, { id: 'b', kind: 'other', title: 'Old', view: { detail: null, output: null } }], type);
  }
  const other = { type: 'message_done', messageId: 'm', text: 'x' };
  assert.equal(enrich(other), other);
  assert.equal(enrich(null), null);
  assert.deepEqual(withView({ id: 'x', detail: { not: 'a string' } }).view, { detail: null, output: null });
});
