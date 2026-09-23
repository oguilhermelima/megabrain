export type Ok<T> = {
  readonly kind: "ok";
  readonly value: T;
  readonly exitCode?: number;
  readonly stderr?: string;
};

export type Failed = {
  readonly kind: "failed";
  readonly error: string;
  readonly exitCode: number;
  readonly stdout?: string;
};

export type Unknown = {
  readonly kind: "unknown";
  readonly reason: string;
  readonly error: string;
  readonly exitCode: number;
};

export type Result<T> = Ok<T> | Failed | Unknown;

export function ok<T>(value: T, exitCode?: number): Ok<T> {
  return exitCode === undefined ? { kind: "ok", value } : { kind: "ok", value, exitCode };
}

export function failed(error: string, exitCode = 1, stdout?: string): Failed {
  return stdout === undefined ? { kind: "failed", error, exitCode } : { kind: "failed", error, exitCode, stdout };
}

export function unknown(reason: string): Unknown {
  return { kind: "unknown", reason, error: reason, exitCode: 1 };
}
