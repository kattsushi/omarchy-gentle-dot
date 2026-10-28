// The vendored highlight.js (third_party/highlight.js) with the languages the chat highlights.
// No node_modules lookup: a plain clone of the plugin runs without `pnpm install`.
import hljs from '../third_party/highlight.js/core.js';
import bash from '../third_party/highlight.js/languages/bash.js';
import c from '../third_party/highlight.js/languages/c.js';
import cpp from '../third_party/highlight.js/languages/cpp.js';
import csharp from '../third_party/highlight.js/languages/csharp.js';
import css from '../third_party/highlight.js/languages/css.js';
import diff from '../third_party/highlight.js/languages/diff.js';
import dockerfile from '../third_party/highlight.js/languages/dockerfile.js';
import go from '../third_party/highlight.js/languages/go.js';
import ini from '../third_party/highlight.js/languages/ini.js';
import java from '../third_party/highlight.js/languages/java.js';
import javascript from '../third_party/highlight.js/languages/javascript.js';
import json from '../third_party/highlight.js/languages/json.js';
import kotlin from '../third_party/highlight.js/languages/kotlin.js';
import lua from '../third_party/highlight.js/languages/lua.js';
import makefile from '../third_party/highlight.js/languages/makefile.js';
import markdown from '../third_party/highlight.js/languages/markdown.js';
import php from '../third_party/highlight.js/languages/php.js';
import phpTemplate from '../third_party/highlight.js/languages/php-template.js';
import plaintext from '../third_party/highlight.js/languages/plaintext.js';
import python from '../third_party/highlight.js/languages/python.js';
import ruby from '../third_party/highlight.js/languages/ruby.js';
import rust from '../third_party/highlight.js/languages/rust.js';
import scss from '../third_party/highlight.js/languages/scss.js';
import shell from '../third_party/highlight.js/languages/shell.js';
import sql from '../third_party/highlight.js/languages/sql.js';
import swift from '../third_party/highlight.js/languages/swift.js';
import typescript from '../third_party/highlight.js/languages/typescript.js';
import xml from '../third_party/highlight.js/languages/xml.js';
import yaml from '../third_party/highlight.js/languages/yaml.js';

const languages = {
  bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, lua,
  makefile, markdown, php, 'php-template': phpTemplate, plaintext, python, ruby, rust, scss,
  shell, sql, swift, typescript, xml, yaml
};
for (const [name, language] of Object.entries(languages)) hljs.registerLanguage(name, language);

export default hljs;
