#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLAYWRIGHT_VERSION = '1.62.1';
export const DEFAULT_ROOT = path.join(os.homedir(), '.megabrain', 'playwright');
export const DEFAULT_USERSCRIPTS = path.join(os.homedir(), '.megabrain', 'userscripts');
export const DEFAULT_DEVICES = path.join(os.homedir(), '.megabrain', 'devices.json');
export const EXTENSION_IDS = {
  ublock: 'uBlock0@raymondhill.net',
  violentmonkey: '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}',
};

const REPOSITORIES = {
  ubol: 'uBlockOrigin/uBOL-home',
  violentmonkey: 'violentmonkey/violentmonkey',
  ublock: 'gorhill/uBlock',
};

const MCP_CONFIG_NAMES = { chromium: 'chromium.json', firefox: 'firefox.json' };
export const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
export const MAX_VIEWPORT_DIMENSION = 10000;
// BrowserStack's 2026 screen-resolution guide (sourcing StatCounter) informs the
// mobile, tablet, and desktop conventions. Its figures are market-share context,
// not device emulation. Ultrawide values are availability conventions; no share
// figures were found for that category.
export const VIEWPORT_CATEGORIES = Object.freeze({
  mobile: Object.freeze({ width: 390, height: 844 }),
  'mobile-small': Object.freeze({ width: 360, height: 800 }),
  'mobile-large': Object.freeze({ width: 414, height: 896 }),
  tablet: Object.freeze({ width: 768, height: 1024 }),
  laptop: Object.freeze({ width: 1366, height: 768 }),
  desktop: Object.freeze({ width: 1920, height: 1080 }),
  'desktop-laptop': Object.freeze({ width: 1366, height: 768 }),
  'desktop-monitor': Object.freeze({ width: 1440, height: 900 }),
  'desktop-qhd': Object.freeze({ width: 2560, height: 1440 }),
  ultrawide: Object.freeze({ width: 3440, height: 1440 }),
  'ultrawide-wide': Object.freeze({ width: 2560, height: 1080 }),
});

// Registry entries intentionally keep only Playwright names. Owned entries are
// CSS viewport sizes, not panel resolutions. Manufacturer specifications support
// the MacBook values; the generic values follow the StatCounter-derived guide.
// The Air 13 value 1440x900 and Air 15 value 1710x1080 were rejected because
// their aspect ratios do not match the published panels. Air 15 has a 1112/1107
// source disagreement; 1112 is retained from the source that matched Air 13.
export const VIEWPORT_DEVICES = Object.freeze({
  iphonese: { label: 'iPhone SE', registry: 'iPhone SE', category: 'mobile' },
  iphonese3: { label: 'iPhone SE (3rd gen)', registry: 'iPhone SE (3rd gen)', category: 'mobile' },
  iphone13mini: { label: 'iPhone 13 Mini', registry: 'iPhone 13 Mini', category: 'mobile' },
  iphone14: { label: 'iPhone 14', registry: 'iPhone 14', category: 'mobile' },
  iphone14promax: { label: 'iPhone 14 Pro Max', registry: 'iPhone 14 Pro Max', category: 'mobile' },
  iphone15: { label: 'iPhone 15', registry: 'iPhone 15', category: 'mobile' },
  iphone15pro: { label: 'iPhone 15 Pro', registry: 'iPhone 15 Pro', category: 'mobile' },
  iphone15promax: { label: 'iPhone 15 Pro Max', registry: 'iPhone 15 Pro Max', category: 'mobile' },
  iphone16: { label: 'iPhone 16', registry: 'iPhone 16', category: 'mobile' },
  iphone16e: { label: 'iPhone 16e', registry: 'iPhone 16e', category: 'mobile' },
  iphone16pro: { label: 'iPhone 16 Pro', registry: 'iPhone 16 Pro', category: 'mobile' },
  iphone16promax: { label: 'iPhone 16 Pro Max', registry: 'iPhone 16 Pro Max', category: 'mobile' },
  // Safari measurement via Appium WebDriver on iOS 26.5, 2026-09-13:
  // window.innerWidth=402, window.innerHeight=714 (outerHeight=874). The
  // Playwright registry reports 402x681; no override is applied because the
  // requested CSS viewport measurement does not reproduce either 874 or 681.
  iphone17: { label: 'iPhone 17', registry: 'iPhone 17', category: 'mobile' },
  iphone17e: { label: 'iPhone 17e', registry: 'iPhone 17e', category: 'mobile' },
  iphone17pro: { label: 'iPhone 17 Pro', registry: 'iPhone 17 Pro', category: 'mobile' },
  iphone17promax: { label: 'iPhone 17 Pro Max', registry: 'iPhone 17 Pro Max', category: 'mobile' },
  galaxys24: { label: 'Galaxy S24', registry: 'Galaxy S24', category: 'mobile' },
  galaxya55: { label: 'Galaxy A55', registry: 'Galaxy A55', category: 'mobile' },
  pixel5: { label: 'Pixel 5', registry: 'Pixel 5', category: 'mobile' },
  pixel7: { label: 'Pixel 7', registry: 'Pixel 7', category: 'mobile' },
  zfold7: { label: 'Galaxy Z Fold 7', registry: 'Galaxy Z Fold 7', category: 'mobile' },
  zfold7cover: { label: 'Galaxy Z Fold 7 Cover', registry: 'Galaxy Z Fold 7 Cover', category: 'mobile' },
  zflip7: { label: 'Galaxy Z Flip 7', registry: 'Galaxy Z Flip 7', category: 'mobile' },
  zflip7cover: { label: 'Galaxy Z Flip 7 Cover', registry: 'Galaxy Z Flip 7 Cover', category: 'mobile' },
  ipadmini: { label: 'iPad Mini', registry: 'iPad Mini', category: 'tablet' },
  ipad7: { label: 'iPad (gen 7)', registry: 'iPad (gen 7)', category: 'tablet' },
  ipad11: { label: 'iPad (gen 11)', registry: 'iPad (gen 11)', category: 'tablet' },
  ipadpro11: { label: 'iPad Pro 11', registry: 'iPad Pro 11', category: 'tablet' },
  galaxytabs4: { label: 'Galaxy Tab S4', registry: 'Galaxy Tab S4', category: 'tablet' },
  galaxytabs9: { label: 'Galaxy Tab S9', registry: 'Galaxy Tab S9', category: 'tablet' },
  macbookair13: {
    label: 'MacBook Air 13-inch', viewport: { width: 1470, height: 956 }, category: 'laptop',
    source: 'Apple MacBook Air technical specifications; panel 2560x1664',
  },
  macbookair15: {
    label: 'MacBook Air 15-inch', viewport: { width: 1710, height: 1112 }, category: 'laptop',
    source: 'Apple MacBook Air technical specifications; panel 2880x1864',
  },
  macbookpro14: {
    label: 'MacBook Pro 14-inch', viewport: { width: 1512, height: 982 }, category: 'laptop',
    deviceScaleFactor: 2,
    source: 'Apple MacBook Pro technical specifications; panel 3024x1964',
  },
  macbookpro16: {
    label: 'MacBook Pro 16-inch', viewport: { width: 1728, height: 1117 }, category: 'laptop',
    source: 'Apple MacBook Pro technical specifications; panel 3456x2234',
  },
  fullhd: { label: 'Full HD desktop', viewport: { width: 1920, height: 1080 }, category: 'desktop', source: 'BrowserStack 2026 screen-resolution guide (StatCounter)' },
  laptop2k: { label: '2K laptop', viewport: { width: 2560, height: 1440 }, category: 'laptop', source: 'BrowserStack 2026 screen-resolution guide (StatCounter)' },
  laptop768: { label: '1366 laptop', viewport: { width: 1366, height: 768 }, category: 'laptop', source: 'BrowserStack 2026 screen-resolution guide (StatCounter)' },
  laptop900: { label: '1440 laptop', viewport: { width: 1440, height: 900 }, category: 'laptop', source: 'BrowserStack 2026 screen-resolution guide (StatCounter)' },
  ultrawide: { label: 'Ultrawide', viewport: { width: 3440, height: 1440 }, category: 'ultrawide', source: 'BrowserStack availability guide' },
  ultrawidefhd: { label: 'Ultrawide Full HD', viewport: { width: 2560, height: 1080 }, category: 'ultrawide', source: 'BrowserStack availability guide' },
});

export function validateViewport(viewport) {
  if (!viewport || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) ||
      viewport.width < 1 || viewport.height < 1 ||
      viewport.width > MAX_VIEWPORT_DIMENSION || viewport.height > MAX_VIEWPORT_DIMENSION) {
    throw new Error(`viewport width and height must be positive integers no greater than ${MAX_VIEWPORT_DIMENSION}`);
  }
  return { width: viewport.width, height: viewport.height };
}

function parseDimension(value, label) {
  if (!/^[0-9]+$/.test(String(value))) throw new Error(`viewport ${label} must be a positive integer`);
  return Number(value);
}

function parseViewport(value) {
  const match = String(value).match(/^([0-9]+)x([0-9]+)$/i);
  if (!match) throw new Error('viewport must use WIDTHxHEIGHT dimensions');
  return { width: parseDimension(match[1], 'width'), height: parseDimension(match[2], 'height') };
}

function normalizeDeviceSlug(slug) {
  return String(slug).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function matchingRegistryDevices(slug, devices) {
  const normalized = normalizeDeviceSlug(slug).replace(/[0-9]+$/, '');
  return Object.keys(devices)
    .filter(name => normalizeDeviceSlug(name).startsWith(normalized))
    .filter(name => !/ landscape$/i.test(name))
    .slice(0, 5);
}

function resolveDeviceSlug(slug, devices, orientation = 'portrait') {
  const normalizedSlug = normalizeDeviceSlug(slug);
  const entry = VIEWPORT_DEVICES[normalizedSlug];
  if (!entry) {
    const matches = matchingRegistryDevices(slug, devices);
    const suffix = matches.length ? `; Playwright registry offers: ${matches.join(', ')}` : '';
    throw new Error(`unknown viewport device: ${slug}${suffix}`);
  }
  if (entry.registry) {
    const registryName = orientation === 'landscape' ? `${entry.registry} landscape` : entry.registry;
    const device = devices[registryName];
    if (!device) {
      const matches = matchingRegistryDevices(entry.registry, devices);
      const suffix = matches.length ? `; Playwright registry offers: ${matches.join(', ')}` : '';
      throw new Error(`viewport device ${slug} requires Playwright device ${registryName}, which is unavailable${suffix}`);
    }
    return validateViewport(device.viewport);
  }
  const viewport = entry.viewport;
  return validateViewport(orientation === 'landscape'
    ? { width: viewport.height, height: viewport.width }
    : viewport);
}

export function resolveViewport(options = {}, devices = {}, fallback = DEFAULT_VIEWPORT) {
  const request = options || {};
  const orientation = request.orientation || 'portrait';
  if (!['portrait', 'landscape'].includes(orientation)) throw new Error('orientation must be portrait or landscape');
  const hasRaw = request.viewport != null || request.width != null || request.height != null;
  const hasCategory = request.category != null;
  if (request.device != null && (hasRaw || hasCategory)) throw new Error('viewport device cannot be combined with raw dimensions or a category');
  if (hasCategory && hasRaw) throw new Error('viewport category cannot be combined with raw dimensions');
  if (request.device != null) {
    return resolveDeviceSlug(request.device, devices, orientation);
  }
  if (hasCategory) {
    const category = VIEWPORT_CATEGORIES[request.category];
    if (!category) throw new Error(`unknown viewport category: ${request.category}; available: ${Object.keys(VIEWPORT_CATEGORIES).join(', ')}`);
    return validateViewport(category);
  }
  if (request.viewport != null) return validateViewport(parseViewport(request.viewport));
  if (hasRaw) return validateViewport({
    width: parseDimension(request.width, 'width'),
    height: parseDimension(request.height, 'height'),
  });
  return validateViewport(fallback);
}

function normalizeDeviceDescriptor(descriptor, { requireSource = false } = {}) {
  const viewport = validateViewport(descriptor.viewport);
  const scale = descriptor.deviceScaleFactor ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('deviceScaleFactor must be a positive number');
  if (typeof (descriptor.isMobile ?? false) !== 'boolean') throw new Error('isMobile must be boolean');
  if (typeof (descriptor.hasTouch ?? false) !== 'boolean') throw new Error('hasTouch must be boolean');
  const normalized = {
    viewport,
    deviceScaleFactor: scale,
    isMobile: descriptor.isMobile ?? false,
    hasTouch: descriptor.hasTouch ?? false,
  };
  if (descriptor.userAgent != null) {
    if (typeof descriptor.userAgent !== 'string' || !descriptor.userAgent) throw new Error('userAgent must be a non-empty string');
    normalized.userAgent = descriptor.userAgent;
  }
  if (descriptor.source != null || requireSource) {
    if (typeof descriptor.source !== 'string' || !descriptor.source.trim()) throw new Error('source must be a non-empty string');
    normalized.source = descriptor.source;
  }
  return normalized;
}

function customDeviceEntry(customDevices, slug) {
  const normalized = normalizeDeviceSlug(slug);
  const found = Object.entries(customDevices || {}).find(([name]) => normalizeDeviceSlug(name) === normalized);
  return found ? found[1] : null;
}

export function resolveDeviceDescriptor(options = {}, devices = {}, customDevices = {}) {
  const request = options || {};
  if (request.device != null) {
    const custom = customDeviceEntry(customDevices, request.device);
    if (custom) return normalizeDeviceDescriptor(custom);
    const normalized = normalizeDeviceSlug(request.device);
    const entry = VIEWPORT_DEVICES[normalized];
    if (!entry) throw new Error(`unknown viewport device: ${request.device}`);
    const orientation = request.orientation || 'portrait';
    if (!['portrait', 'landscape'].includes(orientation)) throw new Error('orientation must be portrait or landscape');
    const registryName = entry.registry
      ? (orientation === 'landscape' ? `${entry.registry} landscape` : entry.registry)
      : null;
    const registry = registryName ? devices[registryName] : null;
    if (entry.registry && !registry) {
      throw new Error(`viewport device ${request.device} requires Playwright device ${registryName}`);
    }
    const registeredViewport = registry?.viewport;
    const ownedViewport = entry.viewport || registeredViewport;
    const viewport = orientation === 'landscape' && !entry.viewport && ownedViewport
      ? { width: ownedViewport.height, height: ownedViewport.width }
      : ownedViewport;
    return normalizeDeviceDescriptor({
      ...registry,
      ...entry,
      viewport,
    });
  }
  const viewport = resolveViewport(request, devices);
  return normalizeDeviceDescriptor({ viewport });
}

export function buildContextOptions(descriptor, extras = {}) {
  const normalized = normalizeDeviceDescriptor(descriptor);
  const options = { ...normalized, ...extras };
  if (extras.colorScheme != null && !['light', 'dark', 'no-preference'].includes(extras.colorScheme)) {
    throw new Error('colorScheme must be light, dark, or no-preference');
  }
  return options;
}

export function readCustomDevices(file = DEFAULT_DEVICES) {
  if (!existsSync(file)) return {};
  const parsed = readJson(file, {});
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`custom device registry must be an object: ${file}`);
  return Object.fromEntries(Object.entries(parsed).map(([slug, descriptor]) => [slug, normalizeDeviceDescriptor(descriptor, { requireSource: true })]));
}

export function upsertCustomDevice(devices, slug, descriptor) {
  const normalizedSlug = normalizeDeviceSlug(slug);
  if (!slug || !normalizedSlug || /[\\/]/.test(slug)) throw new Error('custom device slug must be a non-empty path-safe value');
  if (VIEWPORT_DEVICES[normalizedSlug]) throw new Error(`custom device slug conflicts with built-in device: ${slug}`);
  const existingSlug = Object.keys(devices || {}).find(name => normalizeDeviceSlug(name) === normalizedSlug);
  if (existingSlug && existingSlug !== slug) throw new Error(`custom device slug conflicts with existing device: ${existingSlug}`);
  return { ...(devices || {}), [slug]: normalizeDeviceDescriptor(descriptor, { requireSource: true }) };
}

export function removeCustomDevice(devices, slug) {
  const next = { ...(devices || {}) };
  const normalizedSlug = normalizeDeviceSlug(slug);
  Object.keys(next).filter(name => normalizeDeviceSlug(name) === normalizedSlug).forEach(name => delete next[name]);
  return next;
}

export function writePrivateJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

export function validateStorageStateFile(file) {
  let info;
  try { info = lstatSync(file); } catch { throw new Error(`storage state file does not exist: ${file}`); }
  if (!info.isFile()) throw new Error(`storage state must be a regular file: ${file}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`storage state file has unsafe permissions: ${file}`);
  return file;
}

export async function settlePage(page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    const images = [...document.images];
    await Promise.all(images.map(async image => {
      if (!image.complete) await new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });
      if (image.decode) await image.decode().catch(() => {});
    }));
  });
}

export async function prepareDeterministicRendering(page, { now = '2026-01-01T00:00:00.000Z' } = {}) {
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new Error('freeze time must be a valid date');
  await page.clock.install({ time: timestamp });
  await disableAnimations(page);
}

export async function disableAnimations(page) {
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
}

export async function measureSelectors(page, selectors = {}) {
  if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors)) throw new Error('selectors must be an object');
  return page.evaluate(requested => Object.fromEntries(Object.entries(requested).map(([name, selector]) => {
    const element = document.querySelector(selector);
    if (!element) return [name, null];
    const rect = element.getBoundingClientRect();
    return [name, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
  })), selectors);
}

function outputSegment(value, label) {
  const segment = String(value ?? '');
  if (!segment || segment === '.' || segment === '..' || /[\\/]/.test(segment)) throw new Error(`${label} must be a non-empty path-safe value`);
  return segment;
}

export function buildCapturePaths({
  outputRoot,
  side = 'candidate',
  surface = 'web',
  contentId,
  theme = 'light',
  viewport,
  deviceScaleFactor = 1,
  screen,
}) {
  if (!['candidate', 'baseline'].includes(side)) throw new Error('capture side must be candidate or baseline');
  const dimensions = validateViewport(viewport);
  const scale = Number(deviceScaleFactor);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('deviceScaleFactor must be a positive number');
  const themeSegment = outputSegment(theme, 'theme');
  const viewportSegment = `${dimensions.width}x${dimensions.height}@${String(scale).replace(/\.0$/, '')}x`;
  const directory = path.join(
    outputRoot || path.join(process.cwd(), 'visual-captures'),
    side,
    outputSegment(surface, 'surface'),
    outputSegment(contentId, 'content id'),
    themeSegment,
    viewportSegment,
  );
  const name = outputSegment(screen, 'screen');
  return {
    side,
    surface,
    contentId,
    theme,
    screen,
    image: path.join(directory, `${name}.png`),
    geometry: path.join(directory, `${name}.json`),
    viewport: dimensions,
    deviceScaleFactor: scale,
  };
}

export function listDevicePresets(devices, { filter = '', orientation = 'portrait', customDevices = {} } = {}) {
  if (!['portrait', 'landscape', 'all'].includes(orientation)) throw new Error('orientation must be portrait, landscape, or all');
  const normalizedFilter = normalizeDeviceSlug(filter);
  const entries = Object.entries(VIEWPORT_DEVICES);
  const exactEntries = normalizedFilter
    ? entries.filter(([slug, entry]) => {
      const model = normalizeDeviceSlug(entry.label).replace(/^(iphone|ipad|galaxy|pixel)/, '');
      return slug === normalizedFilter || normalizeDeviceSlug(entry.label) === normalizedFilter || model === normalizedFilter;
    })
    : [];
  const orientations = orientation === 'all' ? ['portrait', 'landscape'] : [orientation];
  const builtIns = (exactEntries.length ? exactEntries : entries).flatMap(([slug, entry]) => {
    if (normalizedFilter && !exactEntries.length && !`${slug} ${entry.label}`.toLowerCase().includes(String(filter).toLowerCase())) return [];
    return orientations.map(selectedOrientation => {
      const registry = entry.registry
        ? (selectedOrientation === 'landscape' ? `${entry.registry} landscape` : entry.registry)
        : undefined;
      const sourceDevice = registry ? devices[registry] : null;
      const viewport = entry.viewport || (registry ? sourceDevice?.viewport : entry.viewport);
      const orientedViewport = viewport && selectedOrientation === 'landscape' && (Boolean(entry.viewport) || !registry)
        ? { width: viewport.height, height: viewport.width }
        : viewport;
      return {
        slug,
        label: entry.label,
        kind: entry.registry ? 'registry' : 'owned',
        ...(registry ? { registry } : {}),
        category: entry.category,
        viewport: orientedViewport || null,
        ...(entry.source ? { source: entry.source } : {}),
      };
    });
  });
  const custom = Object.entries(customDevices || {})
    .filter(([slug, descriptor]) => !normalizedFilter || `${slug} ${descriptor.userAgent || ''}`.toLowerCase().includes(String(filter).toLowerCase()))
    .map(([slug, descriptor]) => ({
      slug,
      label: slug,
      kind: 'custom',
      category: descriptor.isMobile ? 'mobile' : 'desktop',
      viewport: descriptor.viewport,
      deviceScaleFactor: descriptor.deviceScaleFactor,
      isMobile: descriptor.isMobile,
      hasTouch: descriptor.hasTouch,
      ...(descriptor.userAgent ? { userAgent: descriptor.userAgent } : {}),
      source: descriptor.source,
    }));
  return [...builtIns, ...custom];
}

function chromiumPaths(root) {
  return {
    root,
    profile: path.join(root, 'profiles', 'chromium'),
    extensions: {
      ublock: path.join(root, 'extensions', 'chromium', 'ublock-origin-lite'),
      violentmonkey: path.join(root, 'extensions', 'chromium', 'violentmonkey'),
    },
  };
}

function firefoxPaths(root) {
  return {
    root,
    profile: path.join(root, 'profiles', 'firefox'),
    extensions: {
      ublockXpi: path.join(root, 'profiles', 'firefox', 'extensions', `${EXTENSION_IDS.ublock}.xpi`),
      violentmonkeyXpi: path.join(root, 'profiles', 'firefox', 'extensions', `${EXTENSION_IDS.violentmonkey}.xpi`),
    },
  };
}

export function buildBrowserConfig(browser, paths, viewport = DEFAULT_VIEWPORT) {
  const configuredViewport = validateViewport(viewport);
  if (browser === 'chromium') {
    const extensionPaths = [paths.extensions.ublock, paths.extensions.violentmonkey].join(',');
    return {
      browser: {
        browserName: 'chromium',
        userDataDir: paths.profile,
        launchOptions: {
          channel: 'chromium',
          headless: true,
          args: [
            `--disable-extensions-except=${extensionPaths}`,
            `--load-extension=${extensionPaths}`,
          ],
        },
        contextOptions: { viewport: configuredViewport },
      },
    };
  }
  if (browser === 'firefox') {
    return {
      browser: {
        browserName: 'firefox',
        userDataDir: paths.profile,
        launchOptions: {
          headless: true,
          firefoxUserPrefs: {
            'extensions.autoDisableScopes': 0,
            'extensions.enabledScopes': 15,
          },
        },
        contextOptions: { viewport: configuredViewport },
      },
    };
  }
  throw new Error(`unknown browser: ${browser}`);
}

export function validateBrowserConfig(config, browser) {
  const b = config?.browser;
  if (!b || b.browserName !== browser) throw new Error(`${browser} config has the wrong browserName`);
  try {
    validateViewport(b.contextOptions?.viewport);
  } catch (error) {
    throw new Error(`${browser} config has invalid viewport: ${error.message}`);
  }
  if (browser === 'chromium') {
    if (b.launchOptions?.channel !== 'chromium') throw new Error('chromium config must set launchOptions.channel to chromium');
    if (b.launchOptions?.headless !== true) throw new Error('chromium config must be headless');
    if (!b.launchOptions.args?.some(arg => arg.startsWith('--load-extension='))) throw new Error('chromium config must load extensions');
  } else {
    if (b.launchOptions?.headless !== true) throw new Error('firefox config must be headless');
    const prefs = b.launchOptions?.firefoxUserPrefs || {};
    if (prefs['extensions.autoDisableScopes'] !== 0 || prefs['extensions.enabledScopes'] !== 15) {
      throw new Error('firefox config must enable installed extensions');
    }
  }
  if (!b.userDataDir) throw new Error(`${browser} config is missing userDataDir`);
  return { valid: true };
}

export function compareManifest(actual, expected) {
  const mismatches = [];
  const walk = (left, right, key) => {
    if (right && typeof right === 'object' && !Array.isArray(right)) {
      for (const child of Object.keys(right)) walk(left?.[child], right[child], key ? `${key}.${child}` : child);
      return;
    }
    if (left !== right) mismatches.push(`${key}: installed ${left ?? 'missing'}, expected ${right}`);
  };
  walk(actual, expected, '');
  return mismatches;
}

function compareJson(actual, expected, prefix) {
  if (actual === expected) return [];
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') {
    return [`${prefix}: installed ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`];
  }
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...keys].flatMap(key => compareJson(actual[key], expected[key], prefix ? `${prefix}.${key}` : key));
}

export function upsertUserScriptRecord(records, record) {
  const next = records.filter(item => item.name !== record.name);
  next.push(record);
  return next;
}

function jsonWrite(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(file, readFileSync(temp));
  rmSync(temp, { force: true });
}

function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

async function githubRelease(repo) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'accept': 'application/vnd.github+json', 'user-agent': 'megabrain' },
  });
  if (!response.ok) throw new Error(`GitHub latest release failed for ${repo}: HTTP ${response.status}`);
  return response.json();
}

function githubAsset(release, predicate) {
  const asset = release.assets?.find(item => predicate(item.name));
  if (!asset) throw new Error(`release ${release.tag_name} has no matching extension asset`);
  return asset;
}

async function download(url, destination) {
  const response = await fetch(url, { headers: { 'user-agent': 'megabrain' } });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${url}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

function extensionManifest(directory) {
  const direct = path.join(directory, 'manifest.json');
  if (existsSync(direct)) return direct;
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '__MACOSX') continue;
    const found = extensionManifest(path.join(directory, entry.name));
    if (found) return found;
  }
  return null;
}

function unpackExtension(archive, destination) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'megabrain-extension-'));
  try {
    execFileSync('unzip', ['-q', archive, '-d', temporary], { stdio: 'ignore' });
    const manifest = extensionManifest(temporary);
    if (!manifest) throw new Error(`extension archive has no manifest.json: ${archive}`);
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    const source = path.dirname(manifest);
    for (const entry of readdirSync(source)) {
      execFileSync('cp', ['-R', path.join(source, entry), path.join(destination, entry)]);
    }
    return JSON.parse(readFileSync(manifest, 'utf8')).version;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(archive, { force: true });
  }
}

async function installChromiumExtensions(root) {
  const paths = chromiumPaths(root);
  const ubol = await githubRelease(REPOSITORIES.ubol);
  const vm = await githubRelease(REPOSITORIES.violentmonkey);
  const ubolAsset = githubAsset(ubol, name => name.endsWith('.chromium.zip'));
  const vmAsset = githubAsset(vm, name => name.startsWith('Violentmonkey-mv3-') && name.endsWith('.zip'));
  const ubolArchive = path.join(root, 'downloads', ubolAsset.name);
  const vmArchive = path.join(root, 'downloads', vmAsset.name);
  await download(ubolAsset.browser_download_url, ubolArchive);
  await download(vmAsset.browser_download_url, vmArchive);
  const ublockVersion = unpackExtension(ubolArchive, paths.extensions.ublock);
  const violentmonkeyVersion = unpackExtension(vmArchive, paths.extensions.violentmonkey);
  return {
    paths,
    versions: { ublock: ubol.tag_name.replace(/^v/, ''), violentmonkey: violentmonkeyVersion || vm.tag_name.replace(/^v/, '') },
  };
}

async function installFirefoxExtensions(root) {
  const paths = firefoxPaths(root);
  if (path.basename(paths.extensions.ublockXpi) !== `${EXTENSION_IDS.ublock}.xpi` ||
      path.basename(paths.extensions.violentmonkeyXpi) !== `${EXTENSION_IDS.violentmonkey}.xpi`) {
    throw new Error('Firefox extension files must be named by their add-on ids');
  }
  mkdirSync(path.dirname(paths.extensions.ublockXpi), { recursive: true });
  const ublock = await githubRelease(REPOSITORIES.ublock);
  const ublockAsset = githubAsset(ublock, name => name.endsWith('.firefox.signed.xpi'));
  await download(ublockAsset.browser_download_url, paths.extensions.ublockXpi);
  await download('https://addons.mozilla.org/firefox/downloads/latest/violentmonkey/latest.xpi', paths.extensions.violentmonkeyXpi);
  const vmManifest = JSON.parse(execFileSync('unzip', ['-p', paths.extensions.violentmonkeyXpi, 'manifest.json'], { encoding: 'utf8' }));
  return {
    paths,
    versions: {
      ublock: ublock.tag_name.replace(/^v/, ''),
      violentmonkey: vmManifest.version,
    },
  };
}

function playwrightCli(root) {
  return path.join(root, 'node_modules', 'playwright', 'cli.js');
}

function ensurePlaywright(root, browsers) {
  mkdirSync(root, { recursive: true });
  const packageFile = path.join(root, 'node_modules', 'playwright', 'package.json');
  const installed = readJson(packageFile);
  if (installed?.version !== PLAYWRIGHT_VERSION) {
    execFileSync('npm', ['install', '--prefix', root, '--no-save', '--no-package-lock', '--ignore-scripts', `playwright@${PLAYWRIGHT_VERSION}`], { stdio: 'inherit' });
  }
  if (!existsSync(playwrightCli(root))) throw new Error(`Playwright ${PLAYWRIGHT_VERSION} was not installed under ${root}`);
  for (const browser of browsers) execFileSync(process.execPath, [playwrightCli(root), 'install', browser], { stdio: 'inherit' });
}

async function install(root, browser, { viewport = null } = {}) {
  const browsers = browser === 'both' ? ['chromium', 'firefox'] : [browser];
  if (!browsers.every(item => ['chromium', 'firefox'].includes(item))) throw new Error(`browser must be chromium, firefox, or both`);
  ensurePlaywright(root, browsers);
  const manifestFile = path.join(root, 'manifest.json');
  const previous = readJson(manifestFile, { extensions: {}, profiles: {}, userscripts: [] });
  const manifest = {
    ...previous,
    playwrightVersion: PLAYWRIGHT_VERSION,
    installedAt: new Date().toISOString(),
    profiles: { ...(previous.profiles || {}) },
    extensions: { ...(previous.extensions || {}) },
    userscripts: previous.userscripts || [],
  };
  for (const selected of browsers) {
    const previousConfig = readJson(previous.profiles?.[selected]?.configPath || path.join(root, MCP_CONFIG_NAMES[selected]));
    const persistedViewport = previousConfig?.browser?.contextOptions?.viewport || DEFAULT_VIEWPORT;
    const configuredViewport = viewport || validateViewport(persistedViewport);
    if (selected === 'chromium') {
      const installed = await installChromiumExtensions(root);
      mkdirSync(installed.paths.profile, { recursive: true });
      const config = buildBrowserConfig(selected, installed.paths, configuredViewport);
      validateBrowserConfig(config, selected);
      const configPath = path.join(root, MCP_CONFIG_NAMES[selected]);
      jsonWrite(configPath, config);
      manifest.extensions.chromium = installed.versions;
      manifest.profiles.chromium = { configPath, userDataDir: installed.paths.profile };
    } else {
      const installed = await installFirefoxExtensions(root);
      mkdirSync(installed.paths.profile, { recursive: true });
      const config = buildBrowserConfig(selected, installed.paths, configuredViewport);
      validateBrowserConfig(config, selected);
      const configPath = path.join(root, MCP_CONFIG_NAMES[selected]);
      jsonWrite(configPath, config);
      manifest.extensions.firefox = installed.versions;
      manifest.profiles.firefox = { configPath, userDataDir: installed.paths.profile };
    }
  }
  manifest.activeBrowser = browser === 'firefox' ? 'firefox' : 'chromium';
  jsonWrite(manifestFile, manifest);
  return manifest;
}

function manifestFor(root) {
  const manifest = readJson(path.join(root, 'manifest.json'));
  if (!manifest) throw new Error(`browser module is not installed under ${root}`);
  return manifest;
}

async function loadChromium(root, manifest, { chromeUrls = false, viewport = null } = {}) {
  const playwright = await import(pathToFileURL(path.join(root, 'node_modules', 'playwright', 'index.mjs')).href);
  const config = readJson(manifest.profiles.chromium.configPath);
  const args = [...config.browser.launchOptions.args];
  if (chromeUrls) args.push('--extensions-on-chrome-urls');
  const contextOptions = { ...config.browser.contextOptions };
  if (viewport) contextOptions.viewport = validateViewport(viewport);
  const context = await playwright.chromium.launchPersistentContext(config.browser.userDataDir, {
    ...config.browser.launchOptions,
    args,
    ...contextOptions,
  });
  return { context, config };
}

async function extensionWorker(context, name) {
  const find = async () => {
    for (const worker of context.serviceWorkers()) {
      try {
        const found = await worker.evaluate(expected => chrome.runtime.getManifest().name.toLowerCase().includes(expected), name.toLowerCase());
        if (found) return worker;
      } catch {}
    }
    return null;
  };
  let worker = await find();
  for (let attempt = 0; !worker && attempt < 4; attempt += 1) {
    await context.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null);
    worker = await find();
  }
  if (!worker) throw new Error(`could not find the ${name} extension service worker`);
  return worker;
}

async function waitForUserScriptRuntime(worker, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastState = { available: false, type: 'undefined', scripts: [] };
  while (Date.now() < deadline) {
    const state = await worker.evaluate(async () => {
      if (typeof chrome.userScripts === 'undefined') return { available: false, type: 'undefined', scripts: [] };
      try {
        return { available: true, type: typeof chrome.userScripts, scripts: await chrome.userScripts.getScripts() };
      } catch (error) {
        return { available: true, type: typeof chrome.userScripts, scripts: [], error: String(error) };
      }
    }).catch(() => ({ available: false, type: 'unavailable', scripts: [] }));
    lastState = state;
    if (state.available && state.scripts.length > 0) return state;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const detail = lastState.error || `${lastState.type}, ${lastState.scripts.length} registered scripts`;
  throw new Error(`Violentmonkey user-script runtime did not become ready (${detail})`);
}

async function toggleUserScripts(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome://extensions/?id=${extensionId}`);
  const state = await page.evaluate(() => {
    const find = (root, depth) => {
      if (!root || depth > 14) return null;
      for (const element of root.querySelectorAll('*')) {
        if (element.id === 'allow-user-scripts') return element;
        if (element.shadowRoot) {
          const found = find(element.shadowRoot, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    const row = find(document, 0);
    if (!row) return { found: false };
    if (row.checked) return { found: true, checked: true };
    const toggle = row.shadowRoot?.querySelector('cr-toggle') || row.shadowRoot?.querySelector('#crToggle');
    if (!toggle) return { found: true, checked: false, toggle: false };
    toggle.click();
    return { found: true, checked: false, toggle: true };
  });
  if (!state.found || !state.toggle && !state.checked) throw new Error('Chrome user scripts toggle was not found');
  await page.waitForTimeout(1200);
  await page.close();
}

async function sendToOptions(context, extensionId, message) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);
  const result = await page.evaluate(async payload => {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (error) {
      return { error: String(error) };
    }
  }, message);
  await page.close();
  return result;
}

async function installUserScriptInContext(context, extensionId, { code, url, id, isNew }) {
  const response = await sendToOptions(context, extensionId, {
    cmd: 'ParseScript',
    data: {
      code,
      url,
      update: true,
      isNew,
      ...(id != null ? { id } : {}),
    },
  });
  const message = response?.update?.message || '';
  if (response?.error || !/Script instalado|Script atualizado|installed|updated|atualiz/i.test(message)) {
    throw new Error(`Violentmonkey rejected ${path.basename(url)}: ${response?.error || message || JSON.stringify(response)}`);
  }
  if (response.update?.props?.id == null) throw new Error(`Violentmonkey accepted ${path.basename(url)} without a script id`);
  return response;
}

export function userScriptSource(userscripts, name) {
  if (path.basename(name) !== name || !name.endsWith('.user.js')) {
    throw new Error(`userscript must be a .user.js file name inside ${userscripts}; pass the file name, not a path`);
  }
  const file = path.join(userscripts, name);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`userscript not found: ${file}`);
  return { file, code: readFileSync(file, 'utf8') };
}

async function installUserScript(root, userscripts, name, { viewport = null } = {}) {
  const manifest = manifestFor(root);
  if (!manifest.profiles?.chromium) throw new Error('Chromium profile is not installed; userscripts require Chromium');
  const source = userScriptSource(userscripts, name);
  const installUrl = `https://megabrain.local/userscripts/${name}`;
  const { context } = await loadChromium(root, manifest, { chromeUrls: true, viewport });
  try {
    const worker = await extensionWorker(context, 'Violentmonkey');
    const extensionId = new URL(worker.url()).hostname;
    await toggleUserScripts(context, extensionId);
    const before = await sendToOptions(context, extensionId, { cmd: 'GetData', data: { sizes: true } });
    const previous = (before?.scripts || []).find(item => item.props?.id === (manifest.userscripts || []).find(record => record.name === name)?.id ||
      item.custom?.lastInstallURL === installUrl || item.meta?.name === name.replace(/\.user\.js$/, '') || item.meta?.name === name);
    const response = await installUserScriptInContext(context, extensionId, {
      code: source.code,
      url: installUrl,
      isNew: !previous,
      ...(previous?.props?.id != null ? { id: previous.props.id } : {}),
    });
    const message = response?.update?.message || '';
    const data = await sendToOptions(context, extensionId, { cmd: 'GetData', data: { sizes: true } });
    const installed = data?.scripts?.find(item => item.meta?.name === name.replace(/\.user\.js$/, '') || item.meta?.name === name);
    manifest.userscripts = upsertUserScriptRecord(manifest.userscripts || [], {
      name,
      hash: createHash('sha256').update(source.code).digest('hex'),
      id: installed?.props?.id,
      installedAt: new Date().toISOString(),
    });
    jsonWrite(path.join(root, 'manifest.json'), manifest);
    return { name, message: message || 'Script instalado.' };
  } finally {
    await context.close();
  }
}

async function listUserScripts(root) {
  const manifest = manifestFor(root);
  for (const item of manifest.userscripts || []) console.log(`${item.name}\t${item.installedAt || ''}`);
}

async function removeUserScript(root, name, { viewport = null } = {}) {
  const manifest = manifestFor(root);
  const record = (manifest.userscripts || []).find(item => item.name === name);
  if (!record) return;
  const { context } = await loadChromium(root, manifest, { viewport });
  try {
    const worker = await extensionWorker(context, 'Violentmonkey');
    const extensionId = new URL(worker.url()).hostname;
    const data = await sendToOptions(context, extensionId, { cmd: 'GetData', data: { sizes: true } });
    const target = data?.scripts?.find(item => item.props?.id === record.id || item.meta?.name === name.replace(/\.user\.js$/, '') || item.meta?.name === name);
    if (target?.props?.id != null) await sendToOptions(context, extensionId, { cmd: 'RemoveScripts', data: [target.props.id] });
    manifest.userscripts = (manifest.userscripts || []).filter(item => item.name !== name);
    jsonWrite(path.join(root, 'manifest.json'), manifest);
  } finally {
    await context.close();
  }
}

async function e2eProof(root) {
  const manifest = manifestFor(root);
  const chromiumProfile = manifest.profiles?.chromium;
  if (!chromiumProfile) throw new Error('Chromium profile is required for the end-to-end proof');
  const sourceConfig = readJson(chromiumProfile.configPath);
  if (!sourceConfig?.browser) throw new Error(`Chromium config is missing at ${chromiumProfile.configPath}`);

  const isolatedRoot = mkdtempSync(path.join(os.tmpdir(), 'megabrain-web-e2e-'));
  const isolatedProfile = path.join(isolatedRoot, 'profile');
  const isolatedConfigPath = path.join(isolatedRoot, 'chromium.json');
  const isolatedConfig = {
    ...sourceConfig,
    browser: { ...sourceConfig.browser, userDataDir: isolatedProfile },
  };
  jsonWrite(isolatedConfigPath, isolatedConfig);
  const isolatedManifest = {
    ...manifest,
    profiles: {
      ...manifest.profiles,
      chromium: { ...chromiumProfile, configPath: isolatedConfigPath, userDataDir: isolatedProfile },
    },
    userscripts: [],
  };
  let context;
  try {
    ({ context } = await loadChromium(root, isolatedManifest));
    const worker = await extensionWorker(context, 'Violentmonkey');
    const extensionId = new URL(worker.url()).hostname;
    await toggleUserScripts(context, extensionId);
    const proofName = 'megabrain-e2e-proof.user.js';
    const proofUrl = `https://megabrain.local/userscripts/${proofName}`;
    const proofCode = [
      '// ==UserScript==',
      '// @name megabrain-e2e-proof',
      '// @match https://example.com/*',
      '// @run-at document_start',
      '// @grant none',
      '// ==/UserScript==',
      'document.documentElement.setAttribute("data-megabrain-e2e-proof", "ran");',
    ].join('\n');
    const installed = await installUserScriptInContext(context, extensionId, {
      code: proofCode,
      url: proofUrl,
      isNew: true,
    });
    const runtime = await waitForUserScriptRuntime(await extensionWorker(context, 'Violentmonkey'));
    if (runtime.type !== 'object') throw new Error(`userscript runtime exposed unexpected type ${runtime.type}`);
    console.log(`chrome.userScripts apos install: ${runtime.type}`);
    console.log(`userscript runtime entries: ${runtime.scripts.length}`);
    const data = await sendToOptions(context, extensionId, { cmd: 'GetData', data: { sizes: true } });
    const stored = data?.scripts?.find(item => item.props?.id === installed.update.props.id);
    if (!stored) throw new Error('Violentmonkey did not retain the installed proof script');
    if (stored.config?.enabled === 0) throw new Error('Violentmonkey disabled the installed proof script');
    const page = await context.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(
      () => document.documentElement?.getAttribute('data-megabrain-e2e-proof') === 'ran',
      null,
      { timeout: 10000 },
    );
    const proofRan = await page.locator('html').getAttribute('data-megabrain-e2e-proof');
    if (proofRan !== 'ran') throw new Error(`userscript proof marker was ${proofRan || 'missing'} on example.com`);
    console.log('userscript ran example.com: true');
    console.log(`title example.com: ${await page.title()}`);
  } finally {
    if (context) await context.close();
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

async function latestVersions() {
  const [ubol, vm, ublock] = await Promise.all([
    githubRelease(REPOSITORIES.ubol), githubRelease(REPOSITORIES.violentmonkey), githubRelease(REPOSITORIES.ublock),
  ]);
  const response = await fetch('https://addons.mozilla.org/firefox/downloads/latest/violentmonkey/latest.xpi', { headers: { 'user-agent': 'megabrain' } });
  if (!response.ok) throw new Error(`AMO latest Violentmonkey failed: HTTP ${response.status}`);
  const temp = path.join(os.tmpdir(), `megabrain-vm-${process.pid}.xpi`);
  writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  const vmManifest = JSON.parse(execFileSync('unzip', ['-p', temp, 'manifest.json'], { encoding: 'utf8' }));
  rmSync(temp, { force: true });
  return {
    chromium: { ublock: ubol.tag_name.replace(/^v/, ''), violentmonkey: vm.tag_name.replace(/^v/, '') },
    firefox: { ublock: ublock.tag_name.replace(/^v/, ''), violentmonkey: vmManifest.version },
  };
}

async function loadPlaywrightDevices(root) {
  const playwrightFile = path.join(root, 'node_modules', 'playwright', 'index.mjs');
  if (!existsSync(playwrightFile)) throw new Error(`Playwright is not installed under ${root}; install simulator-web first`);
  const playwright = await import(pathToFileURL(playwrightFile).href);
  return playwright.devices || {};
}

function viewportRequestFromArgs(args) {
  const request = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (['--viewport', '--width', '--height', '--device', '--category', '--orientation'].includes(flag)) {
      if (args[index + 1] == null) throw new Error(`${flag} requires a value`);
      request[flag.slice(2)] = args[index + 1];
      index += 1;
    }
  }
  return request;
}

function hasViewportRequest(request) {
  return Object.keys(request).length > 0;
}

async function resolveViewportRequest(root, request, fallback = DEFAULT_VIEWPORT) {
  const devices = request.device != null ? await loadPlaywrightDevices(root) : {};
  return resolveViewport(request, devices, fallback);
}

async function resolveDeviceRequest(root, request) {
  const devices = request.device != null ? await loadPlaywrightDevices(root) : {};
  return resolveDeviceDescriptor(request, devices, readCustomDevices());
}

async function launchBrowser(root, browser, { headless = true } = {}) {
  if (!['chromium', 'firefox'].includes(browser)) throw new Error('browser must be chromium or firefox');
  const manifest = manifestFor(root);
  const profile = manifest.profiles?.[browser];
  if (!profile) throw new Error(`no ${browser} browser profile is installed`);
  const playwright = await import(pathToFileURL(path.join(root, 'node_modules', 'playwright', 'index.mjs')).href);
  const config = readJson(profile.configPath);
  const launchOptions = { ...(config?.browser?.launchOptions || {}), headless };
  delete launchOptions.userDataDir;
  return playwright[browser].launch(launchOptions);
}

function jsonFromFile(file, label) {
  if (!file) return {};
  const value = readJson(file, null);
  if (value == null) throw new Error(`${label} is missing or invalid: ${file}`);
  return value;
}

function captureScreensFromArgs(args) {
  const screensFile = argumentValue(args, '--screens', '');
  if (screensFile) {
    const screens = jsonFromFile(screensFile, 'screens file');
    if (!Array.isArray(screens) || screens.length === 0) throw new Error('screens file must contain a non-empty array');
    return screens.map(screen => ({ ...screen }));
  }
  const url = argumentValue(args, '--url', '');
  const name = argumentValue(args, '--screen', '');
  if (!url || !name) throw new Error('capture and measure require --url and --screen, or --screens FILE');
  return [{
    name,
    url,
    selectors: jsonFromFile(argumentValue(args, '--selectors', ''), 'selectors file'),
  }];
}

function validateScreen(screen) {
  if (!screen || typeof screen !== 'object' || !screen.url || !screen.name) throw new Error('each screen needs name and url');
  if (screen.selectors != null && (typeof screen.selectors !== 'object' || Array.isArray(screen.selectors))) {
    throw new Error(`selectors for ${screen.name} must be an object`);
  }
  return { ...screen, selectors: screen.selectors || {} };
}

function captureRequestFromArgs(args) {
  const request = viewportRequestFromArgs(args);
  return {
    ...request,
    browser: argumentValue(args, '--browser', 'chromium'),
    theme: argumentValue(args, '--theme', 'light'),
    surface: argumentValue(args, '--surface', 'web'),
    contentId: argumentValue(args, '--content-id', 'default'),
    outputRoot: argumentValue(args, '--output-root', path.join(process.cwd(), 'visual-captures')),
    storageState: argumentValue(args, '--storage-state', ''),
    side: args.includes('--baseline') ? 'baseline' : 'candidate',
    replaceBaseline: args.includes('--replace-baseline'),
    fullPage: args.includes('--full-page'),
    freezeTime: argumentValue(args, '--freeze-time', '2026-01-01T00:00:00.000Z'),
  };
}

async function renderScreen(context, screen, freezeTime) {
  const page = await context.newPage();
  await prepareDeterministicRendering(page, { now: freezeTime });
  await page.goto(screen.url, { waitUntil: 'domcontentloaded' });
  await disableAnimations(page);
  await settlePage(page);
  return page;
}

function refuseBaselineOverwrite(paths, replaceBaseline) {
  if (paths.side === 'baseline' && !replaceBaseline && (existsSync(paths.image) || existsSync(paths.geometry))) {
    throw new Error(`baseline already exists; pass --replace-baseline to replace ${paths.image}`);
  }
}

async function runVisualScreens(root, args, { capture = true } = {}) {
  const request = captureRequestFromArgs(args);
  const screens = captureScreensFromArgs(args).map(validateScreen);
  const descriptor = await resolveDeviceRequest(root, request);
  const contextOptions = buildContextOptions(descriptor, {
    colorScheme: request.theme,
    reducedMotion: 'reduce',
    ...(request.storageState ? { storageState: validateStorageStateFile(request.storageState) } : {}),
  });
  const browser = await launchBrowser(root, request.browser);
  const context = await browser.newContext(contextOptions);
  const results = [];
  try {
    for (const screen of screens) {
      const page = await renderScreen(context, screen, request.freezeTime);
      try {
        const geometry = await measureSelectors(page, screen.selectors);
        if (!capture) {
          results.push({ name: screen.name, geometry });
          continue;
        }
        const paths = buildCapturePaths({
          outputRoot: request.outputRoot,
          side: request.side,
          surface: request.surface,
          contentId: request.contentId,
          theme: request.theme,
          viewport: descriptor.viewport,
          deviceScaleFactor: descriptor.deviceScaleFactor,
          screen: screen.name,
        });
        refuseBaselineOverwrite(paths, request.replaceBaseline);
        mkdirSync(path.dirname(paths.image), { recursive: true });
        await page.screenshot({ path: paths.image, fullPage: request.fullPage, animations: 'disabled' });
        writeFileSync(paths.geometry, `${JSON.stringify({
          screen: screen.name,
          viewport: descriptor.viewport,
          deviceScaleFactor: descriptor.deviceScaleFactor,
          fullPage: request.fullPage,
          elements: geometry,
        }, null, 2)}\n`);
        results.push({ ...paths, name: screen.name });
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
  return results;
}

async function saveSession(root, args) {
  const url = argumentValue(args, '--url', '');
  const output = argumentValue(args, '--output', '');
  if (!url || !output) throw new Error('session-save requires --url and --output');
  if (existsSync(output) && !args.includes('--replace')) throw new Error(`session state already exists: ${output}; pass --replace to replace it`);
  const request = captureRequestFromArgs(args);
  const descriptor = await resolveDeviceRequest(root, request);
  const browser = await launchBrowser(root, request.browser, { headless: false });
  const context = await browser.newContext(buildContextOptions(descriptor, { colorScheme: request.theme, reducedMotion: 'reduce' }));
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    console.log('Sign in in the browser, then press Enter here to save session state.');
    await new Promise(resolve => process.stdin.once('data', resolve));
    const state = await context.storageState();
    writePrivateJson(output, state);
    console.log(`saved private session state to ${output}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

function configuredViewport(manifest, browser) {
  const profile = manifest.profiles?.[browser];
  const config = profile ? readJson(profile.configPath) : null;
  return validateViewport(config?.browser?.contextOptions?.viewport || DEFAULT_VIEWPORT);
}

async function setViewport(root, browser, args) {
  if (!['chromium', 'firefox', 'both'].includes(browser)) throw new Error('browser must be chromium, firefox, or both');
  const manifest = manifestFor(root);
  const browsers = (browser === 'both' ? ['chromium', 'firefox'] : [browser])
    .filter(item => manifest.profiles?.[item]);
  if (browsers.length === 0) throw new Error(`no ${browser} browser profile is installed`);
  const request = viewportRequestFromArgs(args);
  const viewport = await resolveViewportRequest(root, request, configuredViewport(manifest, browsers[0]));
  const updates = [];
  for (const selected of browsers) {
    const profile = manifest.profiles[selected];
    const config = readJson(profile.configPath);
    const next = {
      ...config,
      browser: {
        ...config?.browser,
        contextOptions: { ...config?.browser?.contextOptions, viewport },
      },
    };
    validateBrowserConfig(next, selected);
    updates.push({ path: profile.configPath, config: next });
  }
  for (const update of updates) jsonWrite(update.path, update.config);
  return { browsers, viewport };
}

function showViewport(root, browser) {
  if (!['chromium', 'firefox', 'both'].includes(browser)) throw new Error('browser must be chromium, firefox, or both');
  const manifest = manifestFor(root);
  const browsers = (browser === 'both' ? ['chromium', 'firefox'] : [browser])
    .filter(item => manifest.profiles?.[item]);
  if (browsers.length === 0) throw new Error(`no ${browser} browser profile is installed`);
  return browsers.map(selected => ({ browser: selected, viewport: configuredViewport(manifest, selected) }));
}

async function listDevices(root, args) {
  const devices = await loadPlaywrightDevices(root);
  const filter = argumentValue(args, '--filter', '');
  const orientation = argumentValue(args, '--orientation', 'portrait');
  return listDevicePresets(devices, { filter, orientation, customDevices: readCustomDevices(argumentValue(args, '--devices-file', DEFAULT_DEVICES)) });
}

function customDeviceFromArgs(args) {
  const viewport = argumentValue(args, '--viewport', '');
  if (!viewport) throw new Error('device-add requires --viewport WIDTHxHEIGHT');
  const match = String(viewport).match(/^([0-9]+)x([0-9]+)$/);
  if (!match) throw new Error('device-add viewport must use WIDTHxHEIGHT dimensions');
  const source = argumentValue(args, '--source', '');
  if (!source) throw new Error('device-add requires --source');
  return {
    viewport: { width: Number(match[1]), height: Number(match[2]) },
    deviceScaleFactor: Number(argumentValue(args, '--device-scale-factor', '1')),
    isMobile: args.includes('--mobile'),
    hasTouch: args.includes('--touch'),
    ...(argumentValue(args, '--user-agent', '') ? { userAgent: argumentValue(args, '--user-agent', '') } : {}),
    source,
  };
}

function addCustomDevice(args) {
  const slug = positionalArgument(args);
  if (!slug) throw new Error('device-add requires a slug');
  const file = argumentValue(args, '--devices-file', DEFAULT_DEVICES);
  const devices = upsertCustomDevice(readCustomDevices(file), slug, customDeviceFromArgs(args));
  writePrivateJson(file, devices);
  console.log(`saved custom device ${slug} to ${file}`);
}

function removeCustomDeviceFromArgs(args) {
  const slug = positionalArgument(args);
  if (!slug) throw new Error('device-remove requires a slug');
  const file = argumentValue(args, '--devices-file', DEFAULT_DEVICES);
  const devices = removeCustomDevice(readCustomDevices(file), slug);
  writePrivateJson(file, devices);
  console.log(`removed custom device ${slug} from ${file}`);
}

function positionalArgument(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('--')) { index += 1; continue; }
    return args[index];
  }
  return '';
}

export async function doctor(root, { currentVersions = null } = {}) {
  const manifest = readJson(path.join(root, 'manifest.json'));
  if (!manifest) return { status: 'missing', reason: `browser manifest is missing under ${root}`, mismatches: [] };
  const mismatches = [];
  const installedPlaywright = readJson(path.join(root, 'node_modules', 'playwright', 'package.json'));
  if (installedPlaywright?.version !== PLAYWRIGHT_VERSION) {
    mismatches.push(`playwright: installed ${installedPlaywright?.version || 'missing'}, expected ${PLAYWRIGHT_VERSION}`);
  }
  for (const browser of ['chromium', 'firefox']) {
    const profile = manifest.profiles?.[browser];
    if (!profile) continue;
    const config = readJson(profile.configPath);
    const expectedPaths = browser === 'chromium' ? chromiumPaths(root) : firefoxPaths(root);
    let expectedViewport = DEFAULT_VIEWPORT;
    try { expectedViewport = validateViewport(config?.browser?.contextOptions?.viewport || DEFAULT_VIEWPORT); } catch {}
    const expectedConfig = buildBrowserConfig(browser, expectedPaths, expectedViewport);
    try { validateBrowserConfig(config, browser); } catch (error) { mismatches.push(`${browser}: ${error.message}`); }
    mismatches.push(...compareJson(config, expectedConfig, `${browser}.config`));
    if (profile.configPath !== path.join(root, MCP_CONFIG_NAMES[browser])) {
      mismatches.push(`${browser}.configPath: installed ${profile.configPath || 'missing'}, expected ${path.join(root, MCP_CONFIG_NAMES[browser])}`);
    }
    if (!existsSync(profile.userDataDir)) mismatches.push(`${browser}: profile directory is missing`);
  }
  let aged = [];
  try {
    const current = currentVersions || await latestVersions();
    const expected = {};
    for (const browser of Object.keys(manifest.profiles || {})) expected[browser] = current[browser];
    aged = compareManifest(manifest.extensions || {}, expected);
  } catch (error) {
    aged = [`latest extension versions unavailable: ${error.message}`];
  }
  if (mismatches.length) return { status: 'misconfigured', reason: mismatches.join('; '), mismatches, aged };
  if (aged.some(item => item.startsWith('extensions.'))) return { status: 'misconfigured', reason: aged.join('; '), mismatches, aged };
  if (aged.length) return { status: 'unknown', reason: aged[0], mismatches, aged };
  return { status: 'ok', reason: `Playwright ${manifest.playwrightVersion} and browser profiles are current`, mismatches, aged };
}

function argumentValue(args, flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
}

async function main(args) {
  const command = args[0];
  const root = argumentValue(args, '--root', DEFAULT_ROOT);
  switch (command) {
    case 'install': {
      const request = viewportRequestFromArgs(args);
      const viewport = hasViewportRequest(request) ? await resolveViewportRequest(root, request) : null;
      const manifest = await install(root, argumentValue(args, '--browser', 'both'), { viewport });
      console.log(`configured ${manifest.activeBrowser} browser profile with Playwright ${manifest.playwrightVersion}`);
      return;
    }
    case 'userscript-install': {
      const request = viewportRequestFromArgs(args);
      const manifest = manifestFor(root);
      const viewport = hasViewportRequest(request)
        ? await resolveViewportRequest(root, request, configuredViewport(manifest, 'chromium'))
        : null;
      const result = await installUserScript(root, argumentValue(args, '--userscripts', DEFAULT_USERSCRIPTS), argumentValue(args, '--file', ''), { viewport });
      console.log(result.message);
      return;
    }
    case 'userscript-list': await listUserScripts(root); return;
    case 'userscript-remove': {
      const request = viewportRequestFromArgs(args);
      const manifest = manifestFor(root);
      const viewport = hasViewportRequest(request)
        ? await resolveViewportRequest(root, request, configuredViewport(manifest, 'chromium'))
        : null;
      await removeUserScript(root, argumentValue(args, '--file', ''), { viewport });
      return;
    }
    case 'viewport-set': {
      const result = await setViewport(root, argumentValue(args, '--browser', 'both'), args);
      console.log(`configured viewport ${result.viewport.width}x${result.viewport.height} for ${result.browsers.join(', ')}`);
      return;
    }
    case 'viewport-show': {
      for (const item of showViewport(root, argumentValue(args, '--browser', 'both'))) {
        console.log(`${item.browser}: ${item.viewport.width}x${item.viewport.height}`);
      }
      return;
    }
    case 'device-list': {
      for (const item of await listDevices(root, args)) {
        const dimensions = item.viewport ? `${item.viewport.width}x${item.viewport.height}` : 'unavailable';
        const origin = item.kind === 'registry' ? `registry:${item.registry}` : item.kind === 'custom' ? 'custom' : `owned:${item.source}`;
        console.log(`${item.slug}\t${item.label}\t${item.category}\t${origin}\t${dimensions}`);
      }
      return;
    }
    case 'device-add': addCustomDevice(args.slice(1)); return;
    case 'device-remove': removeCustomDeviceFromArgs(args.slice(1)); return;
    case 'capture': {
      for (const item of await runVisualScreens(root, args, { capture: true })) console.log(`captured ${item.name}: ${item.image}`);
      return;
    }
    case 'measure': {
      const results = await runVisualScreens(root, args, { capture: false });
      console.log(JSON.stringify(results.length === 1 ? results[0].geometry : results));
      return;
    }
    case 'session-save': await saveSession(root, args); return;
    case 'doctor': console.log(JSON.stringify(await doctor(root))); return;
    case 'e2e-proof': await e2eProof(root); return;
    default: throw new Error('usage: playwright-web.mjs install|userscript-install|userscript-list|userscript-remove|viewport-set|viewport-show|device-list|device-add|device-remove|capture|measure|session-save|doctor|e2e-proof');
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`megabrain web: ${error.message}`);
    process.exitCode = 1;
  });
}
