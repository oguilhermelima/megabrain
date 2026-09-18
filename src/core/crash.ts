import { failed, ok, type Result } from "./result.js";

export type CrashReport = {
  readonly appName: string;
  readonly appVersion?: string;
  readonly incidentId?: string;
  readonly timestamp?: string;
  readonly exceptionType: string;
  readonly signal?: string;
  readonly termination?: string;
  readonly frames: readonly string[];
};

export type CrashParse =
  | { readonly kind: "report"; readonly value: CrashReport }
  | { readonly kind: "no-match" }
  | { readonly kind: "invalid"; readonly reason: string };

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }

function frameText(frame: unknown, images: readonly unknown[]): string {
  const value = object(frame);
  if (!value) return "<unreadable frame>";
  const index = value.imageIndex;
  const offset = text(value.imageOffset) ?? (typeof value.imageOffset === "number" ? `0x${value.imageOffset.toString(16)}` : "unknown offset");
  const image = typeof index === "number" && Number.isInteger(index) ? object(images[index]) : undefined;
  const name = text(image?.name);
  const path = text(image?.path);
  if (name && path) return `${name} + ${offset} (${path})`;
  if (name) return `${name} + ${offset}`;
  if (typeof index === "number") return `imageIndex ${index} + ${offset}`;
  return `frame + ${offset}`;
}

export function parseCrashReport(contents: string, target: string): CrashParse {
  const newline = contents.indexOf("\n");
  if (newline < 0) return { kind: "invalid", reason: "report body is missing" };
  let header: JsonObject;
  let body: JsonObject;
  try {
    const parsed = object(JSON.parse(contents.slice(0, newline)));
    if (!parsed) return { kind: "invalid", reason: "header is not a JSON object" };
    header = parsed;
  } catch { return { kind: "invalid", reason: "header is not valid JSON" }; }
  try {
    const parsed = object(JSON.parse(contents.slice(newline + 1).trim()));
    if (!parsed) return { kind: "invalid", reason: "body is not a JSON object" };
    body = parsed;
  } catch { return { kind: "invalid", reason: "body is not valid JSON" }; }

  const appName = text(header.app_name);
  if (!appName) return { kind: "invalid", reason: "header app_name is missing" };
  const signingId = text(body.codeSigningID);
  const matches = target.includes(".") ? signingId === target : appName === target;
  if (!matches) return { kind: "no-match" };

  const exception = object(body.exception);
  const exceptionType = text(exception?.type);
  if (!exceptionType) return { kind: "invalid", reason: "exception type is missing" };
  const threads = body.threads;
  const faultingThread = body.faultingThread;
  if (!Array.isArray(threads) || typeof faultingThread !== "number" || !Number.isInteger(faultingThread) || !threads[faultingThread]) {
    return { kind: "invalid", reason: "faultingThread index does not exist in threads" };
  }
  const thread = object(threads[faultingThread]);
  if (!thread || !Array.isArray(thread.frames)) return { kind: "invalid", reason: "faulting thread frames are missing" };
  const images = Array.isArray(body.usedImages) ? body.usedImages : [];
  const termination = object(body.termination);
  return {
    kind: "report",
    value: {
      appName,
      appVersion: text(header.app_version),
      incidentId: text(header.incident_id),
      timestamp: text(header.timestamp),
      exceptionType,
      signal: text(exception?.signal),
      termination: text(termination?.indicator) ?? text(body.termination),
      frames: thread.frames.map((frame) => frameText(frame, images)),
    },
  };
}

export type CrashInput = { readonly path: string; readonly contents: string; readonly modifiedAt: number };
export type SelectedCrash = CrashInput & { readonly value: CrashReport };

export function selectCrashReports(inputs: readonly CrashInput[], target: string, last: number): readonly SelectedCrash[] {
  return inputs
    .slice()
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .flatMap((input) => {
      const parsed = parseCrashReport(input.contents, target);
      return parsed.kind === "report" ? [{ ...input, value: parsed.value }] : [];
    })
    .slice(0, last);
}

export function validateCrashLast(value: string): Result<number> {
  if (!/^[1-9][0-9]*$/.test(value)) return failed(`last must be a positive integer: ${value}`, 2);
  return ok(Number(value));
}
