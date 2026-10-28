import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Panel.pushSettings hands the bar entry's settings to the shared service. A key it leaves out
// disappears from entrySettings, and the next save writes shell.json without it (a sound the user
// turned off comes back on). Every setting the manifest declares must be pushed with its default.
test("pushSettings forwards every manifest setting with the manifest default", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const defaults = manifest.barWidget.defaults;
  const panel = await readFile(new URL("../Panel.qml", import.meta.url), "utf8");
  const body = panel.match(/function pushSettings\(\) \{[\s\S]*?client\.configure\(\{([\s\S]*?)\}\)/)[1];
  const pushed = Object.fromEntries(
    [...body.matchAll(/(\w+):\s*setting\("(\w+)",\s*([^)]+)\)/g)].map(([, key, name, fallback]) => {
      assert.equal(key, name, `${key} reads setting("${name}")`);
      return [key, JSON.parse(fallback.trim().replace(/'/g, '"'))];
    }),
  );
  assert.deepEqual(Object.keys(pushed).sort(), Object.keys(defaults).sort());
  for (const [key, value] of Object.entries(defaults)) assert.deepEqual(pushed[key], value, `default of ${key}`);
});
