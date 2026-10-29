import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readme = () => readFile(new URL('../README.md', import.meta.url), 'utf8');
const section = (text, heading) => {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, heading);
  const next = text.slice(start + heading.length).search(/\n## /);
  return text.slice(start, next < 0 ? undefined : start + heading.length + next);
};

test('README: install is one command plus optional steps in Settings', async () => {
  const install = section(await readme(), '\n## Install\n');
  assert.match(install, /```sh\nomarchy plugin add https:\/\/github\.com\/kattsushi\/omarchy-gentle-dot\.git --enable\n```/);
  assert.match(install, /Settings → Voice → \*\*Enable voice\*\*/);
  assert.match(install, /Settings → Shortcut → \*\*Copy setup\*\*/);
  // No package manager step for voice any more.
  assert.doesNotMatch(install, /pnpm install|npm install/);
});

test('README: requirements trimmed, removal deletes the voice runtime', async () => {
  const text = await readme();
  const requirements = section(text, '\n## Requirements\n');
  assert.match(requirements, /Omarchy 4/);
  assert.match(requirements, /Node\.js 22 or newer/);
  assert.match(requirements, /pw-record/);
  assert.doesNotMatch(requirements, /sherpa-onnx-node package|pnpm/);
  const remove = section(text, '\n### Remove\n');
  assert.match(remove, /rm -rf ~\/\.local\/share\/omarchy-gentle-dot +# the voice runtime and model/);
  assert.doesNotMatch(text, /Voice unavailable: run pnpm install/);
});
