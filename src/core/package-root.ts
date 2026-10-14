import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function isMegabrainPackage(path: string): boolean {
  try {
    const metadata: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof metadata === "object" && metadata !== null &&
      "name" in metadata && typeof metadata.name === "string" &&
      (metadata.name === "megabrain" || metadata.name.endsWith("/megabrain"));
  } catch {
    return false;
  }
}

function packageAbove(moduleUrl: string): string | undefined {
  let directory: string;
  try {
    directory = dirname(fileURLToPath(moduleUrl));
  } catch {
    return undefined;
  }
  while (true) {
    if (isMegabrainPackage(`${directory}/package.json`)) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

// A compiled binary carries its modules in a virtual filesystem, so its assets sit next to the
// real executable instead: bin/megabrain + share/megabrain in a tarball or Linux package, and
// Contents/MacOS/megabrain + Contents/Resources/megabrain in a macOS app bundle. The executable
// is resolved first because agents reach it through a symlink on PATH.
function assetCandidates(executablePath: string): string[] {
  let executable = executablePath;
  try { executable = realpathSync(executablePath); } catch { /* keep the given path */ }
  const parent = dirname(dirname(executable));
  return [join(parent, "share/megabrain"), join(parent, "Resources/megabrain")];
}

export function resolvePackageRoot(moduleUrl: string, override?: string, executablePath: string = process.execPath): string {
  if (override !== undefined && override.length > 0) return override;
  const fromModule = packageAbove(moduleUrl);
  if (fromModule !== undefined) return fromModule;
  const candidates = assetCandidates(executablePath);
  const fromExecutable = candidates.find((candidate) => isMegabrainPackage(join(candidate, "package.json")));
  if (fromExecutable !== undefined) return fromExecutable;
  throw new Error(`could not resolve megabrain package root from module URL ${moduleUrl}: expected an ancestor package.json with name "megabrain", or one in ${candidates.join(" or ")}`);
}
