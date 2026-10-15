import type { DatabaseAdapter } from "../db.js";

export type HiddenItemKind = "repo" | "worktree";
export type HiddenItem = Readonly<{ kind: HiddenItemKind; path: string }>;

export function listHiddenItems(db: DatabaseAdapter): HiddenItem[] {
  return db.query<HiddenItem>("SELECT kind, path FROM hidden_items ORDER BY kind, path").all();
}

export function setHiddenItem(db: DatabaseAdapter, kind: HiddenItemKind, path: string, hidden: boolean): void {
  if (hidden) db.run("INSERT INTO hidden_items (kind, path) VALUES (?, ?) ON CONFLICT DO NOTHING", [kind, path]);
  else db.run("DELETE FROM hidden_items WHERE kind = ? AND path = ?", [kind, path]);
}
