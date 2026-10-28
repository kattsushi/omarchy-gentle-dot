import hljs from './highlighter.mjs';

const palette = {
  keyword: '#f5a9ce', literal: '#c4a7e7', number: '#f6c177', string: '#a6d6b2',
  regexp: '#a6d6b2', comment: '#a5a2b8', doctag: '#a5a2b8', title: '#8bd5e8',
  function: '#8bd5e8', built_in: '#edc8a3', type: '#edc8a3', attr: '#b7bdf8',
  attribute: '#b7bdf8', variable: '#f4b8a4', symbol: '#f6c177', meta: '#c4a7e7',
  tag: '#f5a9ce', name: '#f5a9ce', selector: '#a6d6b2', addition: '#a6d6b2',
  deletion: '#f5a9ce', punctuation: '#cad3f5', operator: '#cad3f5'
};

export function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Unknown or missing languages stay plain escaped code: auto-detection on chat-sized snippets
// guesses wrong too often (Python as CSS, prose as Kotlin).
export function highlight(code, lang) {
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(code);
  const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  // highlight.js emits only escaped source and span tags; Qt has no CSS classes.
  return html.replace(/<span class="([^"]*)">/g, (_, classes) => {
    const key = classes.split(/\s+/).map(c => c.replace(/^hljs-/, '')).find(c => palette[c]);
    return `<span style="color:${palette[key] || '#cad3f5'}">`;
  });
}

export function segments(text) {
  const result = [];
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let prose = '', code = '', fence = null, lang = '';
  for (const line of lines) {
    if (!fence) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/);
      if (open) {
        if (prose) result.push({ type: 'md', text: prose });
        prose = '';
        fence = open[1];
        lang = open[2].trim().split(/\s+/)[0] || '';
      } else prose += line;
    } else if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) {
      const raw = code.replace(/\r?\n$/, '');
      result.push({ type: 'code', lang, code: raw, html: highlight(raw, lang) });
      code = ''; fence = null;
    } else code += line;
  }
  if (fence) {
    result.push({ type: 'code', lang, code, html: highlight(code, lang) });
  }
  if (prose) result.push({ type: 'md', text: prose });
  return result;
}

export const normalized = text => text.replace(/\s+/g, ' ').trim();

// Per-connection state; bounded, and never persisted. Reuse richer streaming text
// only if the old daemon changed whitespace, never if it changed the actual reply.
export function renderer() {
  const recent = new Map();
  const remember = (id, text) => {
    recent.set(id, text);
    if (recent.size > 200) recent.delete(recent.keys().next().value);
  };
  const finish = (message, id) => {
    let text = String(message.text || '');
    const streamed = recent.get(id);
    if (streamed && normalized(streamed) === normalized(text)) text = streamed;
    remember(id, text);
    return { ...message, text, segments: segments(text) };
  };
  return message => {
    if (message.type === 'message_delta') remember(message.messageId, (recent.get(message.messageId) || '') + message.delta);
    if (message.type === 'message_done') return finish(message, message.messageId);
    if (message.type === 'history') return { ...message, messages: (message.messages || []).map(m =>
      m.role === 'assistant' ? finish(m, m.id) : m) };
    return message;
  };
}
