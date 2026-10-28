import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASK, maskValue, maskUrl, maskText } from '../privacy.mjs';

const TAILNET = 'studio-mac.tailnet-example.ts.net';
const IP = '100.64.0.42';

// No masked output may carry any piece of the secret it replaced.
function assertHides(output, ...secrets) {
  for (const secret of secrets) {
    for (const piece of String(secret).split(/[.:\/\[\]@%-]+/).filter(part => part.length >= 3)) {
      assert.ok(!output.includes(piece), `"${output}" leaks "${piece}" of ${secret}`);
    }
  }
}

test('the mask is fixed width: it leaks neither the length nor any character', () => {
  assert.equal(MASK, '••••••••');
  assert.equal(maskValue('a'), MASK);
  assert.equal(maskValue(TAILNET), MASK);
  assert.equal(maskValue(IP), MASK);
  assert.equal(maskValue('4317'), MASK);
  assert.equal(maskValue('~/.config/gentle-dot/remotes/' + TAILNET + '.token'), MASK);
  // Nothing to hide stays empty so placeholders still show.
  for (const empty of ['', '   ', null, undefined]) assert.equal(maskValue(empty), '');
});

test('URLs keep their scheme and the daemon paths, never the authority', () => {
  assert.equal(maskUrl(`wss://${TAILNET}/ws`), 'wss://••••••••/ws');
  assert.equal(maskUrl(`ws://${IP}:4317/ws`), 'ws://••••••••/ws');
  assert.equal(maskUrl('ws://[fd7a:115c:a1e0::1]:4317/ws'), 'ws://••••••••/ws');
  assert.equal(maskUrl(`https://${TAILNET}/health`), 'https://••••••••/health');
  assert.equal(maskUrl(`http://${IP}:4317`), 'http://••••••••');
  assert.equal(maskUrl('ws://127.0.0.1:4317/ws'), 'ws://••••••••/ws');
  // Credentials, other paths, queries and fragments are hidden too (and say so).
  assert.equal(maskUrl(`wss://user:secret@${TAILNET}:8443/ws`), 'wss://••••••••/ws');
  assert.equal(maskUrl(`wss://${TAILNET}/alex/private/ws`), 'wss://••••••••/••••••••');
  assert.equal(maskUrl(`wss://${TAILNET}/ws?token=abc123`), 'wss://••••••••/ws?••••••••');
  assert.equal(maskUrl(`https://${TAILNET}/ws#frag`), 'https://••••••••/ws#••••••••');
  // Not a URL at all: the whole value is hidden.
  assert.equal(maskUrl(TAILNET), MASK);
  assert.equal(maskUrl(''), '');
  assertHides(maskUrl(`wss://user:secret@${TAILNET}:8443/alex/ws?token=abc123`), TAILNET, 'secret', 'user', '8443', 'alex', 'abc123');
});

test('free text: URLs, IPs, DNS names, emails and paths are masked, the words around them stay', () => {
  const cases = [
    [`Testing wss://${TAILNET}/ws…`, 'Testing wss://••••••••/ws…'],
    [`Checking https://${TAILNET}/health…`, 'Checking https://••••••••/health…'],
    [`Sign in to a model provider in the Gentle Dot web UI (https://${TAILNET})`, 'Sign in to a model provider in the Gentle Dot web UI (https://••••••••)'],
    [`Cannot resolve ${TAILNET}. Check the host name (and that MagicDNS is on).`, 'Cannot resolve ••••••••. Check the host name (and that MagicDNS is on).'],
    [`Nothing is listening at ${IP}:4317.`, 'Nothing is listening at ••••••••.'],
    [`Reachable at ${IP}.`, 'Reachable at ••••••••.'],
    ['peer fd7a:115c:a1e0:ab12:4843:cd96:626e:f212 online', 'peer •••••••• online'],
    ['peer fd7a:115c:a1e0::626e:f212%tailscale0 online', 'peer •••••••• online'],
    ['loopback [::1]:4317 and ::ffff:192.168.1.10 here', 'loopback •••••••• and •••••••• here'],
    ['ssh alex@100.64.0.42 or alex@example.com', 'ssh •••••••• or ••••••••'],
    [`The daemon rejected the token in ~/.config/gentle-dot/remotes/${TAILNET}.token.`, 'The daemon rejected the token in ••••••••.'],
    ['saved to /home/alex/.config/gentle-dot/remotes/mac.token', 'saved to ••••••••'],
    [`ws://${TAILNET}:4317/ws, http://${IP}:4317/health; and wss://[fd7a::1]/ws!`, 'ws://••••••••/ws, http://••••••••/health; and wss://••••••••/ws!'],
  ];
  for (const [input, expected] of cases) assert.equal(maskText(input), expected, input);
});

test('free text without connection details is left alone', () => {
  for (const text of [
    'Connected (model: Claude Opus 5.5 1M)',
    'Token rejected',
    'The daemon does not speak protocol v1',
    'Unreachable (no answer within 6 s)',
    'answered HTTP 404 on /health: it does not look like a Gentle Dot daemon.',
    'Reconnect at 12:30:45, e.g. after std::vector changes',
    'Paste its token (pbcopy < ~/.gentle-dot/token on that machine) to finish the test.',
    'On that machine: open Gentle Dot and run `tailscale serve --bg 4317`.',
    'Saved, reconnecting…',
    '',
  ]) assert.equal(maskText(text), text, text);
  assert.equal(maskText(null), '');
});

test('known names are masked even without dots (device names, bare hosts), case-insensitively', () => {
  const terms = ['studio-mac', 'mini', 'Zoë’s Studio Mac', 'x'];
  assert.equal(maskText('Cannot resolve studio-mac. Check it.', terms), 'Cannot resolve ••••••••. Check it.');
  assert.equal(maskText('Nothing is listening at MINI:4317.', terms), 'Nothing is listening at ••••••••.');
  assert.equal(maskText('Device Zoë’s Studio Mac is online', terms), 'Device •••••••• is online');
  assert.equal(maskText('ws://mini:4317/ws', terms), 'ws://••••••••/ws');
  // Whole words only, and one- or two-letter terms are ignored instead of blanking the text.
  assert.equal(maskText('minimal x text', terms), 'minimal x text');
  // Regex characters in a term are literal.
  assert.equal(maskText('a (b+c) host', ['(b+c)']), 'a •••••••• host');
});

test('a long text is masked in linear time', () => {
  const started = Date.now();
  maskText('a'.repeat(200000) + ' ' + 'a.'.repeat(50000) + ' ' + 'ab:'.repeat(50000) + ' ' + '1.'.repeat(50000));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});
