import { readFileSync } from "node:fs";
import { dirname } from "node:path";
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

export function resolvePackageRoot(moduleUrl: string, override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  let directory: string;
  try {
    directory = dirname(fileURLToPath(moduleUrl));
  } catch {
    throw new Error(`could not resolve megabrain package root from module URL ${moduleUrl}: expected an ancestor package.json with name "megabrain"`);
  }

  while (true) {
    if (isMegabrainPackage(`${directory}/package.json`)) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`could not resolve megabrain package root from module URL ${moduleUrl}: expected an ancestor package.json with name "megabrain"`);
}
