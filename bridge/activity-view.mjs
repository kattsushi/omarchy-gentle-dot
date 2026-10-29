// Per-tool views of an activity's `detail` (argument preview) and `output` (result preview),
// so the panel shows commands, queries, paths and results instead of raw JSON (S21).
// The daemon cuts both previews (200 and 2000 chars) and may cut them inside JSON; redaction
// markers ([REDACTED], [TRUNCATED]) are kept as they are. Pure, and never throws.
//
// view(activity) -> {detail: View|null, output: View|null}, where View is one of
//   {type:"code", lang, code, html, extra?}     extra: [{key, value}] shown under the code
//   {type:"terminal", text}
//   {type:"list", items:[{title, meta?}], more?, cut?}
//   {type:"fields", items:[{key, value}], text?}
//   {type:"path", path, extra?, code?}           code: {lang, code, html}, e.g. an edit's diff
//   {type:"text", text}
import { highlight } from './render.mjs';

const ELLIPSIS = '…';
const MAX_ITEMS = 8;
const NOTE_LINES = 5;

// Parses JSON, or recovers what a cut JSON preview still holds: whole values, partial
// objects/arrays, and an unterminated string kept with a trailing "…". `partial` holds the
// objects and arrays that were cut. Anything that is not JSON-shaped gives ok:false.
export function parseLoose(text) {
  const none = { ok: false, value: undefined, cut: false, partial: new WeakSet() };
  if (typeof text !== 'string') return none;
  // Only leading space: a preview cut after a space inside a string keeps that space.
  const s = text.trimStart();
  try {
    return { ok: true, value: JSON.parse(s), cut: false, partial: new WeakSet() };
  } catch {
    // Cut or not JSON at all.
  }
  if (!/^[[{]/.test(s)) return none;
  const partial = new WeakSet();
  let i = 0;
  let cut = false;
  let bad = false;
  const space = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const end = () => { cut = true; i = s.length; };
  const fail = () => { bad = true; i = s.length; };
  const escapes = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

  // Each reader returns {value, done} (done: the value is complete), or null when nothing usable is left.
  const string = () => {
    let out = '';
    for (i++; i < s.length;) {
      const c = s[i];
      if (c === '"') { i++; return { value: out, done: true }; }
      if (c !== '\\') { out += c; i++; continue; }
      const e = s[i + 1];
      if (e === undefined) break;
      if (e === 'u') {
        const hex = s.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += escapes[e] ?? e;
      i += 2;
    }
    end();
    return { value: out + ELLIPSIS, done: false };
  };
  const container = (close, add) => {
    const holder = close === '}' ? {} : [];
    for (i++; ;) {
      space();
      if (i >= s.length) { end(); break; }
      if (s[i] === close) { i++; return { value: holder, done: true }; }
      if (s[i] === ',') { i++; continue; }
      if (!add(holder)) break;
    }
    partial.add(holder);
    return { value: holder, done: false };
  };
  const value = () => {
    space();
    if (i >= s.length) { end(); return null; }
    const c = s[i];
    if (c === '"') return string();
    if (c === '{') return container('}', object => {
      if (s[i] !== '"') { fail(); return false; }
      const key = string();
      if (!key.done) return false;
      space();
      if (i >= s.length) { end(); return false; }
      if (s[i] !== ':') { fail(); return false; }
      i++;
      const item = value();
      if (!item) return false;
      object[key.value] = item.value;
      return item.done;
    });
    if (c === '[') return container(']', array => {
      const item = value();
      if (!item) return false;
      array.push(item.value);
      return item.done;
    });
    const number = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    number.lastIndex = i;
    const match = number.exec(s);
    if (match) {
      i += match[0].length;
      if (i >= s.length) cut = true;
      return { value: Number(match[0]), done: i < s.length };
    }
    for (const [word, literal] of [['true', true], ['false', false], ['null', null]]) {
      if (s.startsWith(word, i)) { i += word.length; return { value: literal, done: true }; }
    }
    // A literal or number cut before it could be read.
    if (/^(?:t(?:r(?:u)?)?|f(?:a(?:l(?:s)?)?)?|n(?:u(?:l)?)?|-)$/.test(s.slice(i))) end();
    else fail();
    return null;
  };
  try {
    const root = value();
    if (bad || !root) return none;
    return { ok: true, value: root.value, cut: true, partial };
  } catch {
    return none;
  }
}

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const scalar = value => typeof value === 'string' ? value : value && typeof value === 'object' ? JSON.stringify(value) : String(value);
const stripAnsi = text => text
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[@-Z\\-_]/g, '')
  .replace(/\r\n/g, '\n');

const text = value => ({ type: 'text', text: value });
const codeOf = (lang, code) => ({ lang, code, html: highlight(code, lang) });
const code = (lang, source, extra) => ({ type: 'code', ...codeOf(lang, source), ...(extra?.length ? { extra } : {}) });

// One level of key/value rows: `first` keys lead in that order, `skip` keys are left out.
function fieldsOf(object, { first = [], skip = [] } = {}) {
  const keys = [...first.filter(key => key in object), ...Object.keys(object).filter(key => !first.includes(key))];
  return keys.filter(key => !skip.includes(key)).map(key => ({ key, value: scalar(object[key]) }));
}
const fields = (object, options) => ({ type: 'fields', items: fieldsOf(object, options) });

const EXTENSIONS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript',
  cts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
  kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp',
  css: 'css', scss: 'scss', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini',
  md: 'markdown', markdown: 'markdown', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', sh: 'bash', bash: 'bash',
  zsh: 'bash', sql: 'sql', lua: 'lua', php: 'php', mk: 'makefile', diff: 'diff', patch: 'diff',
};
function langFor(path) {
  const name = String(path || '').split('/').pop();
  if (/^dockerfile/i.test(name)) return 'dockerfile';
  if (/^(?:gnu)?makefile$/i.test(name)) return 'makefile';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? EXTENSIONS[name.slice(dot + 1).toLowerCase()] || '' : '';
}

const SHELL_TOOLS = new Set(['bash', 'bash_background', 'monitor']);
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls']);
const WEB_TOOLS = new Set(['web_search', 'fetch_content', 'get_search_content', 'source_check', 'web_enable']);
const NOTE_TOOLS = new Set(['mem_save', 'mem_update', 'mem_session_summary']);
const BY_SOURCE = { shell: 'shell', engram: 'memory', files: 'files', web: 'web', subagent: 'subagent' };
const BY_KIND = {
  run: 'shell', command: 'shell', shell: 'shell', memory: 'memory', read: 'files', edit: 'files', write: 'files',
  file: 'files', delegate: 'subagent', subagent: 'subagent', web: 'web',
};
function familyOf(tool) {
  if (SHELL_TOOLS.has(tool) || tool.startsWith('job_')) return 'shell';
  if (tool.startsWith('mem_')) return 'memory';
  if (FILE_TOOLS.has(tool) || tool.startsWith('codegraph')) return 'files';
  if (WEB_TOOLS.has(tool)) return 'web';
  if (tool.startsWith('subagent_')) return 'subagent';
  return '';
}

function shellDetail(raw, parsed) {
  if (!parsed.ok) return code('bash', raw);
  if (!isObject(parsed.value)) return text(raw);
  const command = ['command', 'cmd', 'script'].find(key => typeof parsed.value[key] === 'string');
  if (!command) return fields(parsed.value);
  return code('bash', parsed.value[command], fieldsOf(parsed.value, { skip: [command] }));
}
const shellOutput = raw => {
  const shown = stripAnsi(raw).replace(/\s+$/, '');
  return { type: 'terminal', text: shown || '(no output)' };
};

function noteDetail(raw, parsed) {
  if (!parsed.ok || !isObject(parsed.value)) return text(raw);
  const view = fields(parsed.value, { first: ['title', 'type', 'topic_key'], skip: ['content'] });
  const content = parsed.value.content;
  if (content === undefined) return view;
  const lines = scalar(content).split('\n');
  const shown = lines.length > NOTE_LINES ? [...lines.slice(0, NOTE_LINES), ELLIPSIS].join('\n') : lines.join('\n');
  return view.items.length ? { ...view, text: shown } : text(shown);
}

function dateOf(value) {
  if (typeof value === 'number') {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
  }
  const shown = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(shown) ? shown.slice(0, 10) : shown;
}
function observation(item) {
  const firstLine = typeof item.content === 'string' ? item.content.split('\n').find(line => line.trim()) : '';
  const title = (typeof item.title === 'string' && item.title) || firstLine || (item.id !== undefined ? `#${item.id}` : 'Observation');
  const when = item.created_at ?? item.updated_at ?? item.date ?? item.at;
  const meta = [item.type, item.project, when === undefined || when === null ? '' : dateOf(when)]
    .filter(part => part !== undefined && part !== null && part !== '').map(String).join(' · ');
  return meta ? { title, meta } : { title };
}
function memoryOutput(raw) {
  const parsed = parseLoose(raw);
  if (!parsed.ok) return text(raw);
  let list = parsed.value;
  if (isObject(list)) list = ['results', 'observations', 'memories', 'items'].map(key => list[key]).find(Array.isArray);
  if (!Array.isArray(list)) return text(raw);
  if (!list.length && !parsed.cut) return text('No results');
  const items = [];
  let more = 0;
  for (const item of list) {
    if (isObject(item) && parsed.partial.has(item)) more++;
    else items.push(isObject(item) ? observation(item) : { title: scalar(item) });
  }
  more += Math.max(0, items.length - MAX_ITEMS);
  return {
    type: 'list', items: items.slice(0, MAX_ITEMS), ...(more ? { more } : {}), ...(parsed.cut ? { cut: true } : {}),
  };
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'pattern', 'glob'];
const CHANGE_KEYS = ['oldText', 'newText', 'old_string', 'new_string', 'oldString', 'newString', 'edits', 'diff', 'patch', 'content'];
function diffOf(object) {
  const patch = ['diff', 'patch'].find(key => typeof object[key] === 'string');
  if (patch) return object[patch];
  const lines = [];
  for (const change of Array.isArray(object.edits) ? object.edits : [object]) {
    if (!isObject(change)) continue;
    const before = change.oldText ?? change.old_string ?? change.oldString;
    const after = change.newText ?? change.new_string ?? change.newString;
    if (typeof before === 'string') lines.push(...before.split('\n').map(line => `-${line}`));
    if (typeof after === 'string') lines.push(...after.split('\n').map(line => `+${line}`));
  }
  return lines.length ? lines.join('\n') : '';
}
function filesDetail(raw, parsed, editing) {
  if (!parsed.ok || !isObject(parsed.value)) return text(raw);
  const object = parsed.value;
  const pathKey = PATH_KEYS.find(key => typeof object[key] === 'string');
  const extra = fieldsOf(object, { skip: [pathKey, ...CHANGE_KEYS] });
  let change = null;
  if (editing) {
    const diff = diffOf(object);
    if (diff) change = codeOf('diff', diff);
    else if (typeof object.content === 'string') change = codeOf(langFor(object[pathKey]), object.content);
  }
  if (!pathKey) return change ? code(change.lang, change.code, extra) : { type: 'fields', items: extra };
  return { type: 'path', path: object[pathKey], ...(extra.length ? { extra } : {}), ...(change ? { code: change } : {}) };
}

function webDetail(raw, parsed) {
  if (!parsed.ok || !isObject(parsed.value)) return text(raw);
  if (typeof parsed.value.url === 'string') {
    const extra = fieldsOf(parsed.value, { skip: ['url'] });
    return { type: 'path', path: parsed.value.url, ...(extra.length ? { extra } : {}) };
  }
  return fields(parsed.value, { first: ['query', 'queries'] });
}

const fieldsDetail = (first = []) => (raw, parsed) => parsed.ok && isObject(parsed.value) ? fields(parsed.value, { first }) : text(raw);
function jsonOutput(raw) {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object') return code('json', JSON.stringify(value, null, 2));
  } catch {
    // Not JSON, or cut: shown as it is.
  }
  return text(raw);
}

const present = value => typeof value === 'string' && value.trim() !== '';

export function view(activity) {
  const a = activity && typeof activity === 'object' ? activity : {};
  const tool = typeof a.tool === 'string' ? a.tool.toLowerCase() : '';
  const family = familyOf(tool) || BY_SOURCE[a.source] || BY_KIND[a.kind] || 'other';
  const raw = present(a.detail) ? a.detail : '';
  const parsed = raw ? parseLoose(raw) : null;
  const result = { detail: null, output: null };
  const output = typeof a.output === 'string' ? a.output : null;
  const hasOutput = output !== null && output.trim() !== '';
  switch (family) {
    case 'shell':
      if (raw) result.detail = shellDetail(raw, parsed);
      if (output !== null) result.output = shellOutput(output);
      break;
    case 'memory': {
      const note = NOTE_TOOLS.has(tool) || tool.startsWith('mem_save')
        || (!tool && parsed?.ok && isObject(parsed.value) && 'content' in parsed.value && !('query' in parsed.value));
      if (raw) result.detail = note ? noteDetail(raw, parsed) : fieldsDetail(['query'])(raw, parsed);
      if (hasOutput) result.output = note ? text(output) : memoryOutput(output);
      break;
    }
    case 'files': {
      const editing = tool ? tool === 'edit' || tool === 'write' : /^(?:edit|write)$/.test(a.kind);
      if (raw) result.detail = filesDetail(raw, parsed, editing);
      const reading = tool ? tool === 'read' : a.kind === 'read';
      const lang = reading && parsed?.ok && isObject(parsed.value) ? langFor(PATH_KEYS.map(key => parsed.value[key]).find(path => typeof path === 'string')) : '';
      if (hasOutput) result.output = lang ? code(lang, output) : text(output);
      break;
    }
    case 'web':
      if (raw) result.detail = webDetail(raw, parsed);
      if (hasOutput) result.output = text(output);
      break;
    case 'subagent':
      if (raw) result.detail = fieldsDetail(['agent', 'label', 'task'])(raw, parsed);
      if (hasOutput) result.output = text(output);
      break;
    default:
      if (raw) result.detail = fieldsDetail()(raw, parsed);
      if (hasOutput) result.output = jsonOutput(output);
  }
  return result;
}

// The activity with its view; the raw fields stay as the daemon sent them.
export function withView(activity) {
  if (!activity || typeof activity !== 'object') return activity;
  let shown;
  try {
    shown = view(activity);
  } catch {
    shown = {
      detail: present(activity.detail) ? text(activity.detail) : null,
      output: present(activity.output) ? text(activity.output) : null,
    };
  }
  return { ...activity, view: shown };
}

const withViews = message => message && Array.isArray(message.activities)
  ? { ...message, activities: message.activities.map(withView) } : message;

// Adds `view` to the activities of a daemon message (live activity, history, earlier pages).
export function enrich(message) {
  if (!message || typeof message !== 'object') return message;
  if (message.type === 'activity' && message.activity) return { ...message, activity: withView(message.activity) };
  if ((message.type === 'history' || message.type === 'earlier') && Array.isArray(message.messages))
    return { ...message, messages: message.messages.map(withViews) };
  return message;
}
