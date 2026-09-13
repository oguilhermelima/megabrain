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
  buildCapturePaths,
  buildContextOptions,
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
assert.deepEqual(descriptor.viewport, { width: 402, height: 874 });
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

// Scenario: an operator can add, read, and remove a custom descriptor.
const deviceFile = path.join(work, 'devices.json');
let customDevices = readCustomDevices(deviceFile);
customDevices = upsertCustomDevice(customDevices, 'office', {
  viewport: { width: 1512, height: 982 },
  deviceScaleFactor: 2,
  isMobile: false,
  hasTouch: false,
  userAgent: 'office-agent',
});
writePrivateJson(deviceFile, customDevices);
assert.equal(fs.statSync(deviceFile).mode & 0o777, 0o600);
assert.equal(readCustomDevices(deviceFile).office.userAgent, 'office-agent');
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
  addInitScript: async options => calls.push(['init', options]),
};
await settlePage(fakePage);
await prepareDeterministicRendering(fakePage, { now: '2026-01-01T00:00:00.000Z' });
assert.deepEqual(calls[0], ['load', 'networkidle']);
assert.ok(calls.some(([name]) => name === 'evaluate'), 'settling must await fonts and decoded images');
assert.ok(calls.some(([name]) => name === 'style'), 'rendering must disable animations');
assert.ok(calls.some(([name]) => name === 'init'), 'rendering must freeze the clock');

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

web_root="${HOME}/.megabrain/playwright"
if [ "${MEGABRAIN_WEB_E2E:-true}" = false ]; then
  printf 'skip: visual parity browser scenarios disabled by MEGABRAIN_WEB_E2E=false\n'
elif [ ! -f "$web_root/manifest.json" ]; then
  printf 'skip: visual parity browser scenarios require installed Playwright profiles at %s\n' "$web_root"
else
  printf 'skip: visual parity browser scenarios require a running application URL\n'
fi
