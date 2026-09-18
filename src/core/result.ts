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

export function failed(error: string, exitCode = 1): Failed {
  return { kind: "failed", error, exitCode };
}

export function unknown(reason: string): Unknown {
  return { kind: "unknown", reason, error: reason, exitCode: 1 };
}
