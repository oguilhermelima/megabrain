export type SqlValue = string | number | bigint | null | Uint8Array;

export type DatabaseAdapter = Readonly<{
  run(sql: string, parameters?: readonly SqlValue[]): Readonly<{ changes: number; lastInsertRowid: number | bigint }>;
  query<T>(sql: string): Readonly<{
    all(): T[];
    get(...parameters: SqlValue[]): T | null;
  }>;
}>;

export function encode(value: unknown): string {
  return JSON.stringify(value);
}

export function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
