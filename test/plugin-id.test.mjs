import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

// The plugin id is the repository name; every place the shell or a script addresses the plugin
// must use the manifest's id, or summon, IPC and the service lookup silently stop working.
test('plugin id is omarchy-gentle-dot everywhere the shell or a script addresses it', async () => {
  const id = JSON.parse(await read('manifest.json')).id;
  assert.equal(id, 'omarchy-gentle-dot');
  const client = await read('Client.qml');
  const panel = await read('Panel.qml');
  assert.match(client, new RegExp(`readonly property string pluginId: "${id}"`));
  assert.match(client, new RegExp(`target: "${id}\\.client"`));
  assert.match(panel, new RegExp(`moduleName: "${id}"`));
  assert.match(panel, new RegExp(`ipcTarget: "${id}"`));
  assert.match(panel, new RegExp(`serviceFor\\("${id}"\\)`));
  assert.match(await read('hypr/gentle-dot.lua'), new RegExp(`shell toggle ${id} '\\{\\}'`));
  for (const name of ['Client.qml', 'Panel.qml', 'StickyPanel.qml', 'README.md', 'hypr/gentle-dot.lua', 'manifest.json'])
    assert.doesNotMatch(await read(name), /andresdavid\.gentle-dot/, name);
});
