import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
  utimes,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  createProcessAdapter,
  type ProcessAdapter,
} from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import {
  createName,
  finishJson,
  parseCreateOptions,
  parseFinishOptions,
  parsePullRequestOptions,
  type CreateOptions,
  type FinishOptions,
  type PullRequestOptions,
} from "../../core/worktree-write.js";
import { repoFromOrca } from "./repository-selector.js";
import { resolveCaller } from "./queue-write.js";
import { usageMessage, usageText } from "../../core/usage.js";
import { openDatabase, withWrite } from "../../db/db.js";
import { insertWorktree, finishWorktree } from "../../db/queries/worktrees.js";
import { listRepositories } from "../../db/queries/repositories.js";
import {
  defaultWorktreeLocation,
  parseWorktreeLocation,
  placementFor,
  worktreeParent,
  type WorktreeLocation,
} from "../../core/worktree-location.js";
import { registerMegabrainRepository } from "../../core/project-registry.js";

import { run } from "./worktree-write-base.js";
export type FinishBase = {
  readonly ref: string;
  readonly source: string;
  readonly warning?: string;
};
export type Workspace = {
  readonly id?: string;
  readonly path: string;
};
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function workspaceRecords(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  if (!isRecord(value)) return [];
  const workspaces = value.workspaces;
  if (Array.isArray(workspaces)) return workspaceRecords(workspaces);
  if (isRecord(workspaces)) return workspaceRecords(workspaces);
  return workspaceRecords(value.result);
}
export function stringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    let value: unknown = record;
    for (const part of key.split(".")) {
      if (!isRecord(value)) {
        value = undefined;
        break;
      }
      value = value[part];
    }
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
export async function hasCommand(
  process: ProcessAdapter,
  command: string,
): Promise<boolean> {
  const result = await run(process, "sh", ["-c", "command -v " + command]);
  return result.kind === "ok";
}
export async function workspaceForTarget(
  process: ProcessAdapter,
  target: string,
): Promise<Result<Workspace | undefined>> {
  if (!(await hasCommand(process, "superset"))) return ok(undefined);
  const listed = await run(process, "superset", [
    "workspaces",
    "list",
    "--local",
    "--json",
  ]);
  if (listed.kind !== "ok") return ok(undefined);
  let payload: unknown;
  try {
    payload = JSON.parse(listed.value.stdout);
  } catch {
    return ok(undefined);
  }
  for (const record of workspaceRecords(payload)) {
    const branch = stringField(record, ["branch", "git.branch"])?.replace(
      /^refs\/heads\//,
      "",
    );
    const path = stringField(record, [
      "worktreePath",
      "path",
      "worktree.path",
    ]);
    const name = stringField(record, ["name"]);
    if (target !== branch && target !== path && target !== name) continue;
    if (path === undefined) return ok(undefined);
    return ok({
      path,
      id: stringField(record, ["id", "workspaceId", "workspace.id"]),
    });
  }
  return ok(undefined);
}
function projectRecords(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  if (!isRecord(value)) return [];
  const projects = value.projects;
  if (Array.isArray(projects)) return projectRecords(projects);
  if (isRecord(projects)) return projectRecords(projects);
  return projectRecords(value.result);
}
async function projectIdForPath(
  process: ProcessAdapter,
  repoPath: string,
): Promise<string | undefined> {
  const listed = await run(process, "superset", ["projects", "list", "--json"]);
  if (listed.kind !== "ok") return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(listed.value.stdout);
  } catch {
    return undefined;
  }
  for (const record of projectRecords(payload)) {
    const path = stringField(record, ["path", "localPath", "repoPath"]);
    if (path === repoPath) return stringField(record, ["id", "projectId", "project.id"]);
  }
  return undefined;
}
async function projectNameForPath(
  process: ProcessAdapter,
  repoPath: string,
): Promise<string> {
  const listed = await run(process, "orca", ["repo", "list", "--json"]);
  if (listed.kind === "ok") {
    try {
      const payload: unknown = JSON.parse(listed.value.stdout);
      const result = isRecord(payload) && isRecord(payload.result) ? payload.result : {};
      const repos = Array.isArray(result.repos) ? result.repos : [];
      for (const entry of repos) {
        if (isRecord(entry) && entry.path === repoPath) {
          const name = stringField(entry, ["displayName"]);
          if (name !== undefined) return name;
        }
      }
    } catch {
      // Falls through to the repo directory's basename below.
    }
  }
  return basename(repoPath);
}
type SupersetProject = { readonly id: string };
// Mirrors the retired shell's megabrain_ensure_superset_project: reuse a Superset project already
// registered for this repository path, or register one (importing the repo under its Orca display
// name, falling back to the directory's own basename).
export async function ensureSupersetProject(
  process: ProcessAdapter,
  repoPath: string,
): Promise<Result<SupersetProject>> {
  const existing = await projectIdForPath(process, repoPath);
  if (existing !== undefined) return ok({ id: existing });
  const name = await projectNameForPath(process, repoPath);
  const created = await run(process, "superset", [
    "projects",
    "create",
    "--local",
    "--import",
    repoPath,
    "--name",
    name,
    "--json",
  ]);
  let id: string | undefined;
  if (created.kind === "ok") {
    try {
      const payload: unknown = JSON.parse(created.value.stdout);
      if (isRecord(payload))
        id = stringField(payload, ["result.project.id", "result.id", "project.id", "id"]);
    } catch {
      // Falls through to a fresh lookup below.
    }
  }
  if (id === undefined) id = await projectIdForPath(process, repoPath);
  if (id === undefined) return failed(`could not register Superset project for ${repoPath}`);
  return ok({ id });
}
async function workspaceIdForTarget(
  process: ProcessAdapter,
  target: string,
): Promise<string | undefined> {
  const listed = await run(process, "superset", ["workspaces", "list", "--local", "--json"]);
  if (listed.kind !== "ok") return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(listed.value.stdout);
  } catch {
    return undefined;
  }
  for (const record of workspaceRecords(payload)) {
    const branch = stringField(record, ["branch", "git.branch"])?.replace(/^refs\/heads\//, "");
    const path = stringField(record, ["worktreePath", "path", "worktree.path"]);
    const name = stringField(record, ["name"]);
    if (target === branch || target === path || target === name)
      return stringField(record, ["id", "workspaceId", "workspace.id"]);
  }
  return undefined;
}
async function updateWorkspaceTag(
  process: ProcessAdapter,
  id: string,
  tag: string,
): Promise<boolean> {
  const updated = await run(process, "superset", ["workspaces", "update", id, "--tag", tag, "--json"]);
  return updated.kind === "ok";
}
type WorkspaceRegistration = {
  readonly id: string;
  readonly tagSet: boolean;
  readonly tagError: string | null;
};
// Mirrors the retired shell's megabrain_workspace_create: an existing workspace for this branch
// that also needs a parent tag is only re-tagged (never re-created); otherwise a fresh workspace
// is opened against the branch, then tagged if a parent grouping was requested.
export async function registerSupersetWorkspace(
  process: ProcessAdapter,
  project: SupersetProject,
  branch: string,
  slug: string,
  options: { readonly tag?: string; readonly pr?: string },
): Promise<Result<WorkspaceRegistration>> {
  const existingId = await workspaceIdForTarget(process, branch);
  if (existingId !== undefined && options.tag !== undefined) {
    const tagSet = await updateWorkspaceTag(process, existingId, options.tag);
    return ok({
      id: existingId,
      tagSet,
      tagError: tagSet ? null : `Superset workspace tag was not set for ${existingId}`,
    });
  }
  // --pr opens the workspace against the pull request instead of the branch (the two are
  // mutually exclusive on the Superset side, matching the retired shell's megabrain_workspace_create).
  const created = await run(process, "superset", [
    "workspaces",
    "create",
    "--local",
    "--project",
    project.id,
    ...(options.pr !== undefined ? ["--pr", options.pr] : ["--branch", branch]),
    "--name",
    slug,
    "--json",
  ]);
  let id: string | undefined;
  if (created.kind === "ok") {
    try {
      const payload: unknown = JSON.parse(created.value.stdout);
      if (isRecord(payload))
        id = stringField(payload, ["result.workspace.id", "result.id", "workspace.id", "id"]);
    } catch {
      // Falls through to a fresh lookup below.
    }
  }
  if (id === undefined) id = await workspaceIdForTarget(process, branch);
  if (id === undefined) return failed("could not create Superset workspace");
  if (options.tag === undefined) return ok({ id, tagSet: false, tagError: null });
  const tagSet = await updateWorkspaceTag(process, id, options.tag);
  return ok({
    id,
    tagSet,
    tagError: tagSet ? null : `Superset workspace tag was not set for ${branch}`,
  });
}
