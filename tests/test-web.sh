#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

node --input-type=module - "$root/scripts/playwright-web.mjs" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = process.argv[2];
const {
  DEFAULT_VIEWPORT,
  buildBrowserConfig,
  doctor,
  resolveViewport,
  validateBrowserConfig,
  compareManifest,
  upsertUserScriptRecord,
  userScriptSource,
} = await import(script);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'megabrain-web-test-'));
const paths = {
  root: work,
  profile: path.join(work, 'profiles', 'chromium'),
  extensions: {
    ublock: path.join(work, 'extensions', 'chromium', 'ublock'),
    violentmonkey: path.join(work, 'extensions', 'chromium', 'violentmonkey'),
  },
};

const chromium = buildBrowserConfig('chromium', paths);
assert.equal(chromium.browser.browserName, 'chromium');
assert.equal(chromium.browser.launchOptions.channel, 'chromium');
assert.deepEqual(chromium.browser.contextOptions.viewport, { width: 1280, height: 720 });
assert.equal(validateBrowserConfig(chromium, 'chromium').valid, true);
assert.deepEqual(DEFAULT_VIEWPORT, { width: 1280, height: 720 }, 'the default viewport must stay unchanged');
assert.deepEqual(
  resolveViewport({ viewport: '390x844' }, {}),
  { width: 390, height: 844 },
  'a per-invocation viewport must override the default',
);
assert.deepEqual(
  resolveViewport({ viewport: '390x844' }, {}, { width: 1280, height: 720 }),
  { width: 390, height: 844 },
  'a per-invocation viewport must override the persisted one',
);
assert.deepEqual(
  resolveViewport({ device: 'Test Phone' }, { 'Test Phone': { viewport: { width: 393, height: 852 } } }),
  { width: 393, height: 852 },
  'a named device must resolve through the Playwright registry',
);
assert.throws(
  () => resolveViewport({ viewport: '0x844' }, {}),
  /positive integer/,
  'an invalid viewport must be refused',
);
assert.throws(
  () => validateBrowserConfig({ browser: { browserName: 'chromium', launchOptions: {}, contextOptions: chromium.browser.contextOptions } }, 'chromium'),
  /channel/,
  'a Chromium config without channel must be rejected',
);

const firefox = buildBrowserConfig('firefox', {
  root: work,
  profile: path.join(work, 'profiles', 'firefox'),
  extensions: {
    ublockXpi: path.join(work, 'profiles', 'firefox', 'extensions', 'uBlock0@raymondhill.net.xpi'),
    violentmonkeyXpi: path.join(work, 'profiles', 'firefox', 'extensions', '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}.xpi'),
  },
});
assert.equal(firefox.browser.browserName, 'firefox');
assert.equal(firefox.browser.launchOptions.firefoxUserPrefs['extensions.autoDisableScopes'], 0);
assert.equal(firefox.browser.launchOptions.firefoxUserPrefs['extensions.enabledScopes'], 15);
assert.match(firefox.browser.userDataDir, /profiles[\\/]firefox$/);

const doctorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'megabrain-web-doctor-'));
const doctorConfigPath = path.join(doctorRoot, 'chromium.json');
const doctorProfilePath = path.join(doctorRoot, 'profiles', 'chromium');
fs.mkdirSync(doctorProfilePath, { recursive: true });
fs.mkdirSync(path.join(doctorRoot, 'node_modules', 'playwright'), { recursive: true });
fs.writeFileSync(path.join(doctorRoot, 'node_modules', 'playwright', 'package.json'), JSON.stringify({ version: '1.62.1' }));
fs.writeFileSync(doctorConfigPath, JSON.stringify(buildBrowserConfig('chromium', {
  root: doctorRoot,
  profile: doctorProfilePath,
  extensions: {
    ublock: path.join(doctorRoot, 'extensions', 'chromium', 'ublock-origin-lite'),
    violentmonkey: path.join(doctorRoot, 'extensions', 'chromium', 'violentmonkey'),
  },
}, { width: 390, height: 844 })));
fs.writeFileSync(path.join(doctorRoot, 'manifest.json'), JSON.stringify({
  playwrightVersion: '1.62.1',
  profiles: { chromium: { configPath: doctorConfigPath, userDataDir: doctorProfilePath } },
  extensions: { chromium: { ublock: 'one', violentmonkey: 'two' } },
}));
const doctorReport = await doctor(doctorRoot, { currentVersions: { chromium: { ublock: 'one', violentmonkey: 'two' } } });
assert.equal(doctorReport.status, 'ok', 'doctor must accept a configured non-default viewport');
NODE

viewport_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-web-viewport.XXXXXX")"
cleanup_viewport() {
  rm -rf "$viewport_root"
}
trap cleanup_viewport EXIT
mkdir -p "$viewport_root/profiles/chromium"
node --input-type=module - "$root/scripts/playwright-web.mjs" "$viewport_root" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const script = process.argv[2];
const root = process.argv[3];
const { buildBrowserConfig } = await import(script);
const profile = path.join(root, 'profiles', 'chromium');
const configPath = path.join(root, 'chromium.json');
fs.writeFileSync(configPath, JSON.stringify(buildBrowserConfig('chromium', {
  root,
  profile,
  extensions: { ublock: path.join(root, 'ublock'), violentmonkey: path.join(root, 'violentmonkey') },
})));
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
  profiles: { chromium: { configPath, userDataDir: profile } },
}));
NODE
MEGABRAIN_PLAYWRIGHT_ROOT="$viewport_root" "$root/megabrain" web viewport set --browser chromium --width 390 --height 844 >/dev/null
persisted_viewport="$(jq -c '.browser.contextOptions.viewport' "$viewport_root/chromium.json")"
[ "$persisted_viewport" = '{"width":390,"height":844}' ] || fail "persisted viewport was not honoured: $persisted_viewport"
printf 'ok: viewport defaults, persistence, overrides, presets, validation, and doctor scenarios\n'

node --input-type=module - "$root/scripts/playwright-web.mjs" <<'NODE'
import assert from 'node:assert/strict';
import path from 'node:path';
const { compareManifest, upsertUserScriptRecord, userScriptSource } = await import(process.argv[2]);
const work = '/tmp/megabrain-web-test-scenarios';
const userscripts = path.join(work, 'userscripts');

const expected = {
  playwrightVersion: '1.63.0',
  extensions: {
    chromium: { ublock: '2026.907.2003', violentmonkey: '2.49.0' },
    firefox: { ublock: '1.74.0', violentmonkey: '2.49.0' },
  },
};
const current = structuredClone(expected);
assert.deepEqual(compareManifest(current, expected), []);
current.extensions.chromium.violentmonkey = '2.48.0';
assert.deepEqual(compareManifest(current, expected), ['extensions.chromium.violentmonkey: installed 2.48.0, expected 2.49.0']);

let records = upsertUserScriptRecord([], { name: 'hello.user.js', hash: 'one' });
records = upsertUserScriptRecord(records, { name: 'hello.user.js', hash: 'two' });
assert.equal(records.length, 1, 'refresh must not duplicate a userscript');
assert.equal(records[0].hash, 'two');
assert.throws(
  () => userScriptSource(userscripts, path.join(userscripts, 'hello.user.js')),
  error => error.message.includes(userscripts) && error.message.includes('file name'),
  'a userscript path must explain the expected directory and filename form',
);
console.log('ok: web profile, manifest, and userscript scenarios');
NODE

web_root="$HOME/.megabrain/playwright"
web_install='megabrain install simulator-web --browser chromium'

if [ "${MEGABRAIN_WEB_E2E:-true}" = false ]; then
  printf 'skip: web end-to-end proof disabled by MEGABRAIN_WEB_E2E=false\n'
elif [ ! -d "$web_root/node_modules/playwright" ]; then
  printf 'skip: pinned Playwright is not installed at %s; run %s\n' \
    "$web_root/node_modules/playwright" "$web_install"
elif [ ! -f "$web_root/manifest.json" ]; then
  printf 'skip: browser manifest is missing at %s; run %s\n' \
    "$web_root/manifest.json" "$web_install"
elif [ ! -d "$web_root/profiles/chromium" ]; then
  printf 'skip: Chromium profile is missing at %s; run %s\n' \
    "$web_root/profiles/chromium" "$web_install"
elif [ ! -d "$web_root/extensions/chromium/ublock-origin-lite" ]; then
  printf 'skip: uBlock Origin Lite is missing at %s; run %s\n' \
    "$web_root/extensions/chromium/ublock-origin-lite" "$web_install"
elif [ ! -d "$web_root/extensions/chromium/violentmonkey" ]; then
  printf 'skip: Violentmonkey is missing at %s; run %s\n' \
    "$web_root/extensions/chromium/violentmonkey" "$web_install"
else
  web_browser_path="$(node --input-type=module - "$web_root/node_modules/playwright/index.mjs" <<'NODE'
const { chromium } = await import(process.argv[2]);
process.stdout.write(chromium.executablePath());
NODE
)"
  if [ -z "$web_browser_path" ] || [ ! -x "$web_browser_path" ]; then
    printf 'skip: pinned Chromium binary is missing at %s; run %s\n' \
      "${web_browser_path:-<unknown path>}" "$web_install"
  else
    node "$root/scripts/playwright-web.mjs" e2e-proof
  fi
fi
