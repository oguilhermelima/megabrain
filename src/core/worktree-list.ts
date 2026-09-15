export type PullRequest = {
  readonly number: number;
  readonly state: string;
  readonly url: string;
};

export type GitWorktree = {
  readonly path: string;
  readonly branch: string;
  readonly repository: string;
};

export type ParentConfig = {
  readonly repository: string;
  readonly branch: string;
  readonly parent: string;
};

export type WorktreeListEntry = {
  readonly path: string;
  readonly branch: string;
  readonly parent: string | null;
  readonly inSuperset: boolean;
  readonly pullRequest: PullRequest | null;
};

export type WorktreeListFormat = {
  readonly json: boolean;
  readonly flat: boolean;
};

export function parseGitWorktrees(output: string, repository: string): GitWorktree[] {
  const records: GitWorktree[] = [];
  let path = "";
  let branch = "";
  const flush = (): void => {
    if (path.length > 0) records.push({ path, branch: branch || "detached", repository });
    path = "";
    branch = "";
  };
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length);
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return records;
}

export function parseParentConfig(output: string, repository: string): ParentConfig[] {
  const configs: ParentConfig[] = [];
  for (const line of output.split("\n")) {
    const separator = line.indexOf(" ");
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const parent = line.slice(separator + 1);
    const prefix = "branch.";
    const suffix = ".megabrain-parent";
    if (key.startsWith(prefix) && key.endsWith(suffix) && parent.length > 0) {
      configs.push({ repository, branch: key.slice(prefix.length, -suffix.length), parent });
    }
  }
  return configs;
}

function recordList(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  if (typeof value !== "object" || value === null) return [];
  const object = value as Record<string, unknown>;
  for (const key of ["workspaces", "result"]) {
    const nested = object[key];
    if (Array.isArray(nested)) return recordList(nested);
    if (typeof nested === "object" && nested !== null) {
      const records = recordList(nested);
      if (records.length > 0) return records;
    }
  }
  return [];
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function parseWorkspacePaths(value: unknown): Set<string> {
  const paths = new Set<string>();
  for (const record of recordList(value)) {
    const path = stringField(record, ["worktreePath", "path"]);
    if (path !== undefined) paths.add(path);
  }
  return paths;
}

export function parsePullRequests(value: unknown): Map<string, PullRequest> {
  const pullRequests = new Map<string, PullRequest>();
  for (const record of recordList(value)) {
    const branch = stringField(record, ["headRefName", "headBranch", "branch"]);
    const number = record.number;
    const state = stringField(record, ["state"]);
    const url = stringField(record, ["url"]);
    if (branch !== undefined && typeof number === "number" && Number.isInteger(number) && state !== undefined && url !== undefined) {
      pullRequests.set(branch, { number, state, url });
    }
  }
  return pullRequests;
}

function treeLines(entries: readonly WorktreeListEntry[], parent: string, indent: string): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if ((entry.parent ?? "") !== parent) continue;
    const suffix = entry.pullRequest === null ? "" : ` [${entry.pullRequest.state}]`;
    lines.push(`${indent}${entry.branch} ${entry.path}${suffix}`);
    lines.push(...treeLines(entries, entry.branch, `${indent}  `));
  }
  return lines;
}

export function formatWorktreeList(entries: readonly WorktreeListEntry[], format: WorktreeListFormat): string {
  if (format.json) return `${JSON.stringify(entries, null, 2)}\n`;
  if (format.flat) {
    const lines = ["PATH                                                 BRANCH                           IN_SUPERSET"];
    for (const entry of entries) lines.push(`${entry.path.padEnd(53)} ${entry.branch.padEnd(32)} ${entry.inSuperset ? "yes" : "no"}`);
    return `${lines.join("\n")}\n`;
  }
  return `${["BRANCH                                               PATH", ...treeLines(entries, "", "")].join("\n")}\n`;
}
