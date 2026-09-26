#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

node --input-type=module - "$root/scripts/playwright-web.mjs" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = process.argv[2];
const {
  DEFAULT_VIEWPORT,
  VIEWPORT_DEVICES,
  buildBrowserConfig,
  buildCaptureLaunchOptions,
  buildCapturePaths,
  buildContextOptions,
  captureRequestFromArgs,
  listDevicePresets,
  measureSelectors,
  prepareDeterministicRendering,
  readCustomDevices,
  removeCustomDevice,
  resolveDeviceDescriptor,
  settlePage,
  upsertCustomDevice,
  validateStorageStateFile,
  writePrivateJson,
} = await import(script);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'megabrain-web-visual-test-'));

// Scenario: a named device preserves all Playwright context fields, not only size.
const registry = {
  'iPhone 17': {
    viewport: { width: 402, height: 681 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'iphone-17-registry-agent',
  },
};
const descriptor = resolveDeviceDescriptor({ device: 'iphone17' }, registry);
const registryDeviceName = VIEWPORT_DEVICES.iphone17.registry;
assert.equal(registryDeviceName, 'iPhone 17');
assert.deepEqual(descriptor.viewport, registry[registryDeviceName].viewport);
assert.equal(descriptor.deviceScaleFactor, 3);
assert.equal(descriptor.isMobile, true);
assert.equal(descriptor.hasTouch, true);
assert.equal(descriptor.userAgent, 'iphone-17-registry-agent');
assert.deepEqual(resolveDeviceDescriptor({}, {}), {
  viewport: DEFAULT_VIEWPORT,
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
});
assert.deepEqual(buildContextOptions(descriptor), descriptor);

// Scenario: an operator must provide a source for a custom descriptor.
assert.throws(
  () => upsertCustomDevice({}, 'unsourced', {
    viewport: { width: 1512, height: 982 },
  }),
  /source/,
  'a custom device must be traceable to a source',
);

// Scenario: an operator can add, read, and remove a traceable custom descriptor.
const deviceFile = path.join(work, 'devices.json');
let customDevices = readCustomDevices(deviceFile);
customDevices = upsertCustomDevice(customDevices, 'office', {
  viewport: { width: 1512, height: 982 },
  deviceScaleFactor: 2,
  isMobile: false,
  hasTouch: false,
  userAgent: 'office-agent',
  source: 'local device lab measurement, 2026-09-13',
});
writePrivateJson(deviceFile, customDevices);
assert.equal(fs.statSync(deviceFile).mode & 0o777, 0o600);
assert.equal(readCustomDevices(deviceFile).office.userAgent, 'office-agent');
assert.equal(readCustomDevices(deviceFile).office.source, 'local device lab measurement, 2026-09-13');
assert.deepEqual(
  listDevicePresets({}, { filter: 'office', customDevices: readCustomDevices(deviceFile) }),
  [{
    slug: 'office',
    label: 'office',
    kind: 'custom',
    category: 'desktop',
    viewport: { width: 1512, height: 982 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
    userAgent: 'office-agent',
    source: 'local device lab measurement, 2026-09-13',
  }],
  'custom device listings must retain traceability metadata',
);
assert.throws(
  () => upsertCustomDevice({}, 'iphone17', {
    viewport: { width: 402, height: 714 },
    source: 'local device lab measurement, 2026-09-13',
  }),
  /conflicts with built-in device/,
  'a custom device must not shadow a built-in slug',
);
customDevices = removeCustomDevice(customDevices, 'office');
assert.deepEqual(customDevices, {});

// Scenario: storage state accepts only an existing private regular file.
const stateFile = path.join(work, 'state.json');
assert.throws(() => validateStorageStateFile(stateFile), /does not exist/);
writePrivateJson(stateFile, { cookies: [], origins: [] });
assert.equal(validateStorageStateFile(stateFile), stateFile);
fs.chmodSync(stateFile, 0o644);
assert.throws(() => validateStorageStateFile(stateFile), /permissions/);
fs.chmodSync(stateFile, 0o600);
fs.mkdirSync(path.join(work, 'state-directory'));
assert.throws(() => validateStorageStateFile(path.join(work, 'state-directory')), /regular file/);

// Scenario: candidate and baseline paths are distinct and scale is metadata, not resizing.
const candidate = buildCapturePaths({
  outputRoot: work,
  side: 'candidate',
  surface: 'web',
  contentId: 'movie-42',
  theme: 'dark',
  viewport: { width: 1512, height: 982 },
  deviceScaleFactor: 2,
  screen: 'details',
});
assert.equal(candidate.image, path.join(work, 'candidate', 'web', 'movie-42', 'dark', '1512x982@2x', 'details.png'));
assert.equal(candidate.geometry, path.join(work, 'candidate', 'web', 'movie-42', 'dark', '1512x982@2x', 'details.json'));
assert.equal(candidate.viewport.width, 1512);
assert.equal(candidate.deviceScaleFactor, 2);
assert.equal(buildCapturePaths({ ...candidate, outputRoot: work, side: 'baseline' }).side, 'baseline');
assert.throws(() => buildCapturePaths({ ...candidate, outputRoot: work, side: 'unknown' }), /side/);

// Scenario: settle and deterministic preparation share observable browser operations.
const calls = [];
const fakePage = {
  waitForLoadState: async state => calls.push(['load', state]),
  evaluate: async () => calls.push(['evaluate']),
  addStyleTag: async options => calls.push(['style', options.content]),
  clock: { install: async options => calls.push(['clock', options]) },
};
await settlePage(fakePage);
await prepareDeterministicRendering(fakePage, { now: '2026-01-01T00:00:00.000Z' });
assert.deepEqual(calls[0], ['load', 'networkidle']);
assert.ok(calls.some(([name]) => name === 'evaluate'), 'settling must await fonts and decoded images');
assert.ok(calls.some(([name]) => name === 'style'), 'rendering must disable animations');
assert.deepEqual(
  calls.find(([name]) => name === 'clock'),
  ['clock', { time: 1767225600000 }],
  'rendering must freeze Playwright clock at the chosen instant',
);
assert.equal(calls.some(([name]) => name === 'init'), false, 'rendering must not patch Date in page script');

// Scenario: an image with no terminal event is reported after the per-image timeout.
const previousDocument = globalThis.document;
globalThis.document = {
  fonts: { ready: Promise.resolve() },
  images: [{ complete: false, alt: 'avatar image', addEventListener: () => {}, removeEventListener: () => {} }],
};
let slowImages;
try {
  slowImages = await Promise.race([
    settlePage({
      waitForLoadState: async () => {},
      evaluate: async evaluate => evaluate(10),
    }, { imageTimeout: 10 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('settlePage exceeded test deadline')), 50)),
  ]);
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}
assert.deepEqual(slowImages, ['avatar image'], 'settling must name images that exceed the timeout');

// Scenario: capture and measure strip browsing extensions from their launch.
const browsingChromiumConfig = buildBrowserConfig('chromium', {
  profile: '/tmp/chromium-profile',
  extensions: { ublock: '/tmp/ublock', violentmonkey: '/tmp/violentmonkey' },
});
const captureChromiumOptions = buildCaptureLaunchOptions(browsingChromiumConfig, 'chromium');
assert.ok(
  browsingChromiumConfig.browser.launchOptions.args.some(arg => arg.startsWith('--load-extension=')),
  'browsing profile must keep its extensions',
);
assert.equal(
  captureChromiumOptions.args.some(arg => arg.startsWith('--load-extension=') || arg.startsWith('--disable-extensions-except=')),
  false,
  'capture launch must not load browsing extensions',
);
const browsingFirefoxConfig = buildBrowserConfig('firefox', {
  profile: '/tmp/firefox-profile',
  extensions: { ublockXpi: '/tmp/ublock.xpi', violentmonkeyXpi: '/tmp/violentmonkey.xpi' },
});
assert.equal(
  Object.hasOwn(buildCaptureLaunchOptions(browsingFirefoxConfig, 'firefox'), 'firefoxUserPrefs'),
  false,
  'capture launch must not enable installed Firefox extensions',
);

// Scenario: visual commands retain an explicitly supplied config path.
const visualRequest = captureRequestFromArgs([
  'capture', '--config', '/tmp/clean-chromium.json', '--image-timeout', '125',
]);
assert.equal(visualRequest.config, '/tmp/clean-chromium.json');
assert.equal(visualRequest.imageTimeout, 125);

// Scenario: no freeze flag leaves the browser clock untouched.
const noClockCalls = [];
await prepareDeterministicRendering({
  addStyleTag: async () => {},
  clock: { install: async options => noClockCalls.push(options) },
});
assert.deepEqual(noClockCalls, [], 'the clock must remain real unless --freeze-time is supplied');

const suppliedClockCalls = [];
await prepareDeterministicRendering({
  addStyleTag: async () => {},
  clock: { install: async options => suppliedClockCalls.push(options) },
}, { now: '2030-05-06T07:08:09.000Z' });
assert.deepEqual(
  suppliedClockCalls,
  [{ time: 1904281689000 }],
  'the caller must be able to choose the frozen instant',
);

// Scenario: geometry is extracted from the same page visit as the capture.
const geometryPage = {
  evaluate: async (_fn, selectors) => {
    assert.deepEqual(selectors, { title: '.title', poster: '[data-poster]' });
    return {
      title: { x: 1, y: 2, width: 3, height: 4 },
      poster: { x: 5, y: 6, width: 7, height: 8 },
    };
  },
};
assert.deepEqual(await measureSelectors(geometryPage, { title: '.title', poster: '[data-poster]' }), {
  title: { x: 1, y: 2, width: 3, height: 4 },
  poster: { x: 5, y: 6, width: 7, height: 8 },
});

console.log('ok: visual parity scenarios');
NODE

# Scenario: the public CLI persists and removes custom device descriptors.
cli_devices_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-web-devices.XXXXXX")"
cli_devices_file="$cli_devices_root/devices.json"
MEGABRAIN_PLAYWRIGHT_ROOT="$cli_devices_root" "$root/.build/megabrain" web devices add studio \
  --devices-file "$cli_devices_file" --viewport 1000x700 --device-scale-factor 2 \
  --source 'QA simulator measurement, 2026-09-13' >/dev/null
jq -e '.studio.source == "QA simulator measurement, 2026-09-13"' "$cli_devices_file" >/dev/null
MEGABRAIN_PLAYWRIGHT_ROOT="$cli_devices_root" "$root/.build/megabrain" web devices remove studio \
  --devices-file "$cli_devices_file" >/dev/null
jq -e 'has("studio") | not' "$cli_devices_file" >/dev/null

web_root="${HOME}/.megabrain/playwright"
if [ "${MEGABRAIN_WEB_E2E:-true}" = false ]; then
  printf 'skip: visual parity browser scenarios disabled by MEGABRAIN_WEB_E2E=false\n'
elif [ ! -f "$web_root/manifest.json" ]; then
  printf 'skip: visual parity browser scenarios require installed Playwright profiles at %s\n' "$web_root"
else
  printf 'skip: visual parity browser scenarios require a running application URL\n'
fi
