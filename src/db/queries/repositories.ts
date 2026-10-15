import type { DatabaseAdapter } from "../db.js";

export type RepositorySource = "megabrain" | "import";
export type RepositoryRecord = Readonly<{ name: string; path: string; remote: string | null; source: RepositorySource; addedAt: string }>;
type RepositoryRow = Readonly<{ name: string; path: string; remote: string | null; source: RepositorySource; added_at: string }>;
export type RepositoryPullRequestCache = Readonly<{ value: string; fetchedAt: number }>;

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
  return db.query<RepositoryRow>("SELECT name, path, remote, source, added_at FROM repositories ORDER BY name COLLATE NOCASE, path").all().map(fromRow);
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
