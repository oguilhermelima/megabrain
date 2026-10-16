import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { writePrivateJson } from "./private-json.js";
import { failed, ok, type Result } from "./result.js";
import { resolveStateDirectory, type StateEnvironment } from "./state.js";

// How the person sees a project, kept only by megabrain: the repository is never touched.
export type Appearance = { name?: string; color?: string; picture?: string };
export type ProjectAppearance = { projects: Record<string, Appearance> };
// A string sets the field, null clears it, undefined leaves it. For picture the string is a source image file.
export type AppearancePatch = { name?: string | null; color?: string | null; picture?: string | null };

const PICTURE_LIMIT = 2 * 1024 * 1024;
const PICTURE_TYPES: Readonly<Record<string, string>> = { ".png": "png", ".jpg": "jpg", ".jpeg": "jpg", ".webp": "webp", ".svg": "svg" };

const settingsFile = (environment: StateEnvironment) => join(resolveStateDirectory(environment), "project-settings.json");
const picturesDirectory = (environment: StateEnvironment) => join(resolveStateDirectory(environment), "project-pictures");

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function readProjectAppearance(environment: StateEnvironment): Promise<ProjectAppearance> {
  try {
    const raw: unknown = JSON.parse(await readFile(settingsFile(environment), "utf8"));
    const projects = typeof raw === "object" && raw !== null ? (raw as { projects?: unknown }).projects : undefined;
    if (typeof projects !== "object" || projects === null || Array.isArray(projects)) return { projects: {} };
    const result: Record<string, Appearance> = {};
    for (const [path, entry] of Object.entries(projects)) {
      if (typeof entry !== "object" || entry === null) continue;
      const { name, color, picture } = entry as Record<string, unknown>;
      const appearance: Appearance = { ...(text(name) && { name: text(name) }), ...(text(color) && { color: text(color) }), ...(text(picture) && { picture: text(picture) }) };
      if (Object.keys(appearance).length > 0) result[path] = appearance;
    }
    return { projects: result };
  } catch { return { projects: {} }; }
}

async function storePicture(environment: StateEnvironment, source: string): Promise<Result<string>> {
  const type = PICTURE_TYPES[extname(source).toLowerCase()];
  if (type === undefined) return failed("project-appearance: the picture must be a png, jpg, webp or svg file", 2);
  const info = await stat(source).catch(() => undefined);
  if (info === undefined || !info.isFile()) return failed(`project-appearance: picture not found: ${source}`, 2);
  if (info.size > PICTURE_LIMIT) return failed("project-appearance: the picture is larger than 2 MB", 2);
  const bytes = await readFile(source);
  const directory = picturesDirectory(environment);
  const target = join(directory, `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${type}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, target);
  return ok(target);
}

export async function setProjectAppearance(environment: StateEnvironment, project: string, patch: AppearancePatch): Promise<Result<ProjectAppearance>> {
  if (!isAbsolute(project)) return failed("project-appearance: the project must be an absolute repository path", 2);
  if (typeof patch.name === "string" && (patch.name.trim() === "" || patch.name.length > 200)) return failed("project-appearance: a name must be 1 to 200 characters", 2);
  if (typeof patch.color === "string" && !/^#[0-9a-fA-F]{6}$/.test(patch.color)) return failed("project-appearance: a color must look like #rrggbb", 2);
  let picture: string | null | undefined;
  if (typeof patch.picture === "string") {
    const stored = await storePicture(environment, patch.picture);
    if (stored.kind !== "ok") return stored;
    picture = stored.value;
  } else picture = patch.picture;

  const current = await readProjectAppearance(environment);
  const before = current.projects[project];
  const next: Appearance = { ...before };
  if (patch.name !== undefined) { if (patch.name === null) delete next.name; else next.name = patch.name.trim(); }
  if (patch.color !== undefined) { if (patch.color === null) delete next.color; else next.color = patch.color.toLowerCase(); }
  if (picture !== undefined) { if (picture === null) delete next.picture; else next.picture = picture; }
  if (Object.keys(next).length === 0) delete current.projects[project]; else current.projects[project] = next;
  await writePrivateJson(settingsFile(environment), { version: 1, projects: current.projects });

  // The old copy goes only after the new settings are saved, and only when no other project still shows it.
  const old = before?.picture;
  if (old !== undefined && old !== next.picture && !Object.values(current.projects).some((entry) => entry.picture === old)) await rm(old, { force: true });
  return ok(current);
}
