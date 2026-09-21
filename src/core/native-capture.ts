import { join } from "node:path";

export type NativeCaptureFrame = Readonly<{
  name: string;
  hash: string;
}>;

export type NativeCaptureRecord = NativeCaptureFrame & Readonly<{
  image: string;
  requestedRoute: string;
  reachedPathname: string;
  stableDurationMs: number;
  sampleCount: number;
}>;

export type NativeCaptureFailureRecord = Readonly<{
  name: string;
  requestedRoute: string;
  image: null;
  failure: string;
}>;

export type NativeCaptureScreenRecord = NativeCaptureRecord | NativeCaptureFailureRecord;

export type NativeCaptureOutcome = Readonly<{
  captured: number;
  distinct: number;
  controlMatches: readonly string[];
  duplicateGroups: readonly (readonly string[])[];
  failed: boolean;
  failureReasons: readonly string[];
  summary: string;
}>;

export type NativeCapturePaths = Readonly<{
  directory: string;
  image: string;
  manifest: string;
}>;

function pathSegment(value: string, label: string): string {
  if (!value || value === "." || value === ".." || /[\\/]/.test(value)) {
    throw new Error(`${label} must be a non-empty path-safe value`);
  }
  return value;
}

export function decideCaptureOutcome({
  controlHash,
  screens,
}: {
  readonly controlHash: string;
  readonly screens: readonly NativeCaptureFrame[];
}): NativeCaptureOutcome {
  const controlMatches = screens.filter((screen) => screen.hash === controlHash).map((screen) => screen.name);
  const groups = new Map<string, string[]>();
  for (const screen of screens) {
    const names = groups.get(screen.hash) ?? [];
    names.push(screen.name);
    groups.set(screen.hash, names);
  }
  const duplicateGroups = [...groups.values()].filter((names) => names.length > 1);
  const failureReasons = [
    ...duplicateGroups.map((names) => `screens share a hash: ${names.join(", ")}`),
  ];
  const distinct = groups.size;
  const groupsText = duplicateGroups.length > 0
    ? `, groups: ${duplicateGroups.map((names) => names.join(", ")).join("; ")}`
    : "";
  return {
    captured: screens.length,
    distinct,
    controlMatches,
    duplicateGroups,
    failed: controlMatches.length > 0 || failureReasons.length > 0,
    failureReasons,
    summary: `${screens.length} captured, ${distinct} distinct${groupsText}`,
  };
}

export function buildNativeCapturePaths({
  outputRoot,
  surface,
  captureId,
  theme,
  viewport,
  screen,
}: {
  readonly outputRoot: string;
  readonly surface: string;
  readonly captureId: string;
  readonly theme: string;
  readonly viewport: string;
  readonly screen: string;
}): NativeCapturePaths {
  const directory = join(outputRoot, pathSegment(surface, "surface"), pathSegment(captureId, "capture id"));
  const themeDirectory = join(directory, pathSegment(theme, "theme"), pathSegment(viewport, "viewport"));
  const name = pathSegment(screen, "screen");
  return {
    directory,
    image: join(themeDirectory, `${name}.png`),
    manifest: join(directory, "manifest.json"),
  };
}

export function buildNativeCaptureRecord({
  paths,
  name,
  hash,
  stableDurationMs,
  sampleCount,
  requestedRoute,
  reachedPathname,
}: {
  readonly paths: NativeCapturePaths;
  readonly name: string;
  readonly hash: string;
  readonly stableDurationMs: number;
  readonly sampleCount: number;
  readonly requestedRoute: string;
  readonly reachedPathname: string;
}): NativeCaptureRecord {
  return { name, hash, stableDurationMs, sampleCount, image: paths.image, requestedRoute, reachedPathname };
}

export function buildNativeCaptureFailureRecord({
  name,
  requestedRoute,
  failure,
}: {
  readonly name: string;
  readonly requestedRoute: string;
  readonly failure: string;
}): NativeCaptureFailureRecord {
  return { name, requestedRoute, image: null, failure };
}
