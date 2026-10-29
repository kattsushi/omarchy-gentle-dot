import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poll, qml } from './composer-harness.test.mjs';

// `hyprctl binds -j` as Hyprland 0.56 prints it: Lua binds carry only their description,
// hyprlang binds their exec command.
const bind = fields => ({ locked: false, mouse: false, release: false, repeat: false, modmask: 0, submap: '', key: '',
  keycode: 0, catch_all: false, description: '', has_description: false, dispatcher: '__lua', arg: '1', ...fields });
const unrelated = [bind({ modmask: 64, key: 'RETURN', description: 'Terminal', has_description: true }),
  bind({ modmask: 72, key: 'D', description: 'Docker', has_description: true })];
const luaBound = [...unrelated, bind({ modmask: 72, key: 'D', description: 'Gentle Dot', has_description: true, arg: '11' })];
const execBound = [...unrelated, bind({ modmask: 69, key: 'g', dispatcher: 'exec', arg: "omarchy-shell shell toggle omarchy-gentle-dot '{}'" })];

const hyprctl = binds => `#!/bin/sh\n[ "$1 $2" = "binds -j" ] || exit 3\ncat <<'EOF'\n${JSON.stringify(binds)}\nEOF\n`;

test('Settings → Shortcut: detects the binding from hyprctl and copies the setup snippet', async t => {
  const out = await mkdtemp(join(tmpdir(), 'gentle-shortcut-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const files = {
    'hyprctl-lua': hyprctl(luaBound),
    'hyprctl-exec': hyprctl(execBound),
    'hyprctl-none': hyprctl(unrelated),
    'hyprctl-fail': '#!/bin/sh\nexit 1\n',
    'wl-copy': `#!/bin/sh\ncat > ${JSON.stringify(join(out, 'copied.txt'))}\n`
  };
  await qml(t, `
  Plugin.Client { id: client; entrySettings: ({notifications: false}) }
  FloatingWindow {
    visible: true; width: 640; height: 2400
    Plugin.SettingsView {
      id: settings; client: client; anchors.fill: parent
      hyprctlCommand: String(Qt.resolvedUrl("hyprctl-none")).replace(/^file:\\/\\//, "")
      clipboardCommand: String(Qt.resolvedUrl("wl-copy")).replace(/^file:\\/\\//, "")
    }
  TestCase {
    id: checks; when: false
    function eq(actual, expected, what) { if (actual !== expected) throw Error((what || "") + " expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)) }
    ${poll}
    function path(name) { return String(Qt.resolvedUrl(name)).replace(/^file:\\/\\//, "") }
    function label() { return findChild(settings, "shortcutState").text }
    function detect(name, expected) {
      settings.hyprctlCommand = path(name)
      settings.checkShortcut()
      until(function() { return label() === expected }, 10000, name + ": " + label())
    }
    function run() {
      try {
        // Checked when Settings is created.
        until(function() { return label() === "Keyboard shortcut: SUPER + ALT + D (not set up)" }, 10000, label())
        detect("hyprctl-lua", "Keyboard shortcut: SUPER + ALT + D (set up)")
        // A hyprlang exec bind on other keys: those keys are shown.
        detect("hyprctl-exec", "Keyboard shortcut: SUPER + CTRL + SHIFT + G (set up)")
        detect("hyprctl-fail", "Keyboard shortcut: SUPER + ALT + D (could not check)")
        detect("hyprctl-none", "Keyboard shortcut: SUPER + ALT + D (not set up)")
        eq(settings.shortcutFrom("not json").state, "unknown")
        eq(settings.shortcutFrom("[]").state, "missing")
        // Copy setup: the snippet goes to the clipboard; nothing is written to the Hyprland config.
        var copy = findChild(settings, "copyShortcut")
        check(copy && copy.visible, "Copy setup button")
        eq(copy.text, "Copy setup")
        press(copy)
        until(function() { return settings.shortcutFeedback !== "" }, 10000, "copy feedback")
        eq(settings.shortcutFeedback, 'Copied. Save it as ~/.config/hypr/gentle-dot.lua and add require("hypr.gentle-dot") to ~/.config/hypr/hyprland.lua.')
        console.log("QML_PASS")
      } catch (e) { console.log("QML_FAIL: " + e) }
      Qt.quit()
    }
  }
  Timer { interval: 100; running: true; onTriggered: checks.run() }
  }
  `, { files, timeout: 30000 });
  assert.equal(await readFile(join(out, 'copied.txt'), 'utf8'), await readFile(new URL('../hypr/gentle-dot.lua', import.meta.url), 'utf8'));
});
