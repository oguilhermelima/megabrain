import type { DatabaseAdapter } from "../db.js";

export type RepositorySource = "megabrain" | "import";
export type RepositoryRecord = Readonly<{ name: string; path: string; remote: string | null; source: RepositorySource; addedAt: string }>;
type RepositoryRow = Readonly<{ name: string; path: string; remote: string | null; source: RepositorySource; added_at: string }>;
export type RepositoryPullRequestCache = Readonly<{ value: string; fetchedAt: number }>;
export type RepositoryCursor = Readonly<{ name: string; path: string }>;
export type RepositoryPage = Readonly<{ rows: RepositoryRecord[]; nextCursor?: RepositoryCursor }>;

function fromRow(row: RepositoryRow): RepositoryRecord {
  return { name: row.name, path: row.path, remote: row.remote, source: row.source, addedAt: row.added_at };
}

export function registerRepository(db: DatabaseAdapter, repository: RepositoryRecord): RepositoryRecord {
  db.run("INSERT INTO repositories (name, path, remote, source, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO NOTHING", [repository.name, repository.path, repository.remote, repository.source, repository.addedAt]);
  const row = db.query<RepositoryRow>("SELECT name, path, remote, source, added_at FROM repositories WHERE path = ?").get(repository.path);
  if (row === null) throw new Error(`repository registration failed for ${repository.path}`);
  return fromRow(row);
}

export function listRepositories(db: DatabaseAdapter): RepositoryRecord[] {
  const repositories: RepositoryRecord[] = [];
  let after: RepositoryCursor | undefined;
  for (;;) {
    const page = listRepositoriesPage(db, { after });
    repositories.push(...page.rows);
    if (page.nextCursor === undefined) return repositories;
    after = page.nextCursor;
  }
}

export function listRepositoriesPage(db: DatabaseAdapter, options: Readonly<{ after?: RepositoryCursor; limit?: number }> = {}): RepositoryPage {
  const limit = Math.max(1, Math.min(1_000, Math.trunc(options.limit ?? 100)));
  const rows = options.after === undefined
    ? db.query<RepositoryRow>("SELECT name, path, remote, source, added_at FROM repositories ORDER BY name COLLATE NOCASE, path LIMIT ?").all(limit)
    : db.query<RepositoryRow>("SELECT name, path, remote, source, added_at FROM repositories WHERE name COLLATE NOCASE > ? OR (name COLLATE NOCASE = ? AND path > ?) ORDER BY name COLLATE NOCASE, path LIMIT ?").all(options.after.name, options.after.name, options.after.path, limit);
  const records = rows.map(fromRow);
  const last = rows.at(-1);
  return { rows: records, ...(rows.length === limit && last !== undefined ? { nextCursor: { name: last.name, path: last.path } } : {}) };
}

export function getRepositoryPullRequests(db: DatabaseAdapter, path: string): RepositoryPullRequestCache | undefined {
  const row = db.query<{ value_json: string; fetched_at: number }>("SELECT value_json, fetched_at FROM repository_pull_requests WHERE repository_path = ?").get(path);
  return row === null ? undefined : { value: row.value_json, fetchedAt: row.fetched_at };
}

export function saveRepositoryPullRequests(db: DatabaseAdapter, path: string, value: string, fetchedAt: number): void {
  db.run("INSERT INTO repository_pull_requests (repository_path, value_json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(repository_path) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at", [path, value, fetchedAt]);
}

export function findRepository(db: DatabaseAdapter, selector: string): RepositoryRecord | undefined {
  const row = db.query<RepositoryRow>("SELECT name, path, remote, source, added_at FROM repositories WHERE path = ? OR name = ? ORDER BY CASE WHEN path = ? THEN 0 ELSE 1 END LIMIT 1").get(selector, selector, selector);
  return row === null ? undefined : fromRow(row);
}

export function removeRepository(db: DatabaseAdapter, selector: string): RepositoryRecord | undefined {
  const repository = findRepository(db, selector);
  if (repository === undefined) return undefined;
  db.run("DELETE FROM repositories WHERE path = ?", [repository.path]);
  return repository;
}
