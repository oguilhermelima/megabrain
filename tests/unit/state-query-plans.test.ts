import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DatabaseHandle } from "../../src/db/db.js";
import { startStateOwner, stopStateOwner } from "../../src/db/state-owner.js";

const root = resolve(fileURLToPath(new URL("../../src", import.meta.url)));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function stateSqlStatements(): string[] {
  const files = [join(root, "db", "queries"), join(root, "adapters", "state"), join(root, "db", "state-owner-operations.ts")].flatMap((path) => path.endsWith(".ts") ? [path] : sourceFiles(path));
  const statements = new Set<string>();
  for (const file of files) {
    const contents = readFileSync(file, "utf8");
    const calls = /\.(?:query|run)(?:\s*<[^>]+>)?\s*\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`([^`]*?)`)/gs;
    for (const match of contents.matchAll(calls)) {
      const raw = match[1] ?? match[2] ?? match[3];
      if (raw === undefined || raw.includes("${")) continue;
      const sql = match[1] !== undefined ? JSON.parse(`"${raw}"`) as string : raw.replaceAll("\\'", "'");
      statements.add(sql.trim());
    }
  }
  return [...statements].filter((sql) => /^(SELECT|UPDATE|DELETE|INSERT|REPLACE)\b/i.test(sql));
}

function explain(handle: DatabaseHandle, sql: string): string[] {
  const count = (sql.match(/\?/g) ?? []).length;
  const values: unknown[] = Array.from({ length: count }, () => null);
  for (const match of sql.matchAll(/\bLIKE\s+\?/gi)) {
    const before = sql.slice(0, match.index ?? 0);
    values[(before.match(/\?/g) ?? []).length] = "state-%";
  }
  const rows = handle.db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).all(...values);
  return rows.map((row) => row.detail);
}

describe("state database query plans", () => {
  test("large state listings use bounded cursor pages", () => {
    const unbounded = stateSqlStatements().filter((sql) => /\bFROM\s+(?:outbox|repositories)\b/i.test(sql) && /\bORDER\s+BY\b/i.test(sql) && !/\bLIMIT\b/i.test(sql)
      || /\bFROM\s+dispatches\b/i.test(sql) && /\bORDER\s+BY\s+created_at\s*,\s*id\b/i.test(sql) && !/\bLIMIT\b/i.test(sql));
    expect(unbounded).toEqual([]);
  });

  test("every static state-layer prepared statement avoids a full table scan", async () => {
    const directory = mkdtempSync(join(tmpdir(), "megabrain-query-plans-"));
    const owner = await startStateOwner(directory);
    try {
      const violations: string[] = [];
      for (const sql of stateSqlStatements()) {
        try {
          const plan = explain(owner.handle, sql);
          for (const detail of plan) {
            if (/\bSCAN\s+(?!SUBQUERY|CONSTANT ROW)([A-Za-z_][A-Za-z_0-9]*)\b/i.test(detail) && !/\bUSING\s+(?:COVERING\s+)?INDEX\b/i.test(detail)) {
              violations.push(`${sql}\n  ${detail}`);
            }
          }
        } catch (cause) {
          violations.push(`${sql}\n  EXPLAIN failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      expect(violations).toEqual([]);
    } finally {
      await stopStateOwner(owner);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
