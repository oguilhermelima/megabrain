import type { ProcessAdapter } from "../../../adapters/proc.js";
import { connectMetroInspector, type MetroEvaluation } from "../../../core/native-cdp.js";
import { failed, ok, type Result } from "../../../core/result.js";
import { error } from "./index.js";
import { logBoxExpression, devLoadingViewExpression } from "./inspector.js";

export type NativeLogBoxStatus = "ignored" | "absent";

export type NativeDevLoadingViewStatus = "prevented" | "fallback" | "absent";

export type NativeResetOverlayStatus = Readonly<{
  logBox: NativeLogBoxStatus;
  devLoadingView: NativeDevLoadingViewStatus;
}>;

export async function silenceNativeLogBox(processAdapter: ProcessAdapter, metroPort: number, timeoutMs: number): Promise<Result<NativeLogBoxStatus>> {
  const connection = await connectMetroInspector(metroPort, timeoutMs);
  if (connection.kind !== "ok") return connection;
  try {
    const evaluation = await connection.value.evaluate(logBoxExpression, timeoutMs);
    if (evaluation.kind !== "ok") return evaluation;
    if (evaluation.value.kind === "exception") return error(`could not silence LogBox: ${evaluation.value.message}`);
    if (typeof evaluation.value.value !== "object" || evaluation.value.value === null || typeof (evaluation.value.value as { present?: unknown }).present !== "boolean") return error("could not silence LogBox: inspector returned invalid registry data");
    return ok((evaluation.value.value as { present: boolean }).present ? "ignored" : "absent");
  } finally {
    connection.value.close();
  }
}

export async function preventNativeDevLoadingView(processAdapter: ProcessAdapter, metroPort: number, timeoutMs: number): Promise<Result<NativeDevLoadingViewStatus>> {
  const connection = await connectMetroInspector(metroPort, timeoutMs);
  if (connection.kind !== "ok") return connection;
  try {
    const evaluation = await connection.value.evaluate(devLoadingViewExpression, timeoutMs);
    if (evaluation.kind !== "ok") return evaluation;
    if (evaluation.value.kind === "exception") return error(`could not prevent DevLoadingView: ${evaluation.value.message}`);
    if (typeof evaluation.value.value !== "object" || evaluation.value.value === null || typeof (evaluation.value.value as { present?: unknown }).present !== "boolean") return error("could not prevent DevLoadingView: inspector returned invalid registry data");
    const value = evaluation.value.value as { present: boolean; prevented?: unknown };
    if (!value.present) return ok("absent");
    return ok(value.prevented === true ? "prevented" : "fallback");
  } finally {
    connection.value.close();
  }
}

export async function silenceNativeOverlays(processAdapter: ProcessAdapter, metroPort: number, timeoutMs: number): Promise<Result<NativeResetOverlayStatus>> {
  const logBox = await silenceNativeLogBox(processAdapter, metroPort, timeoutMs);
  if (logBox.kind !== "ok") return logBox;
  const devLoadingView = await preventNativeDevLoadingView(processAdapter, metroPort, timeoutMs);
  if (devLoadingView.kind !== "ok") return devLoadingView;
  return ok({ logBox: logBox.value, devLoadingView: devLoadingView.value });
}

export function nativeOverlaySummary(name: string, presentVerb: string, absentSummary: string, counts: Readonly<{ present: number; absent: number }>): string {
  if (counts.present === 0 && counts.absent === 0) return `${name} not checked`;
  if (counts.present > 0 && counts.absent === 0) return counts.present === 1 ? `${name} ${presentVerb}` : `${name} ${presentVerb} after ${counts.present} resets`;
  if (counts.present === 0) return absentSummary;
  return `${name} ${presentVerb} after ${counts.present} resets; ${counts.absent} resets without ${name}`;
}

export function nativeDevLoadingViewSummary(counts: Readonly<{ prevented: number; fallback: number; absent: number }>): string {
  const summaries: string[] = [];
  if (counts.prevented > 0) summaries.push(counts.prevented === 1 ? "DevLoadingView prevented" : `DevLoadingView prevented after ${counts.prevented} resets`);
  if (counts.fallback > 0) summaries.push(counts.fallback === 1 ? "DevLoadingView hide-only fallback" : `DevLoadingView hide-only fallback after ${counts.fallback} resets`);
  if (counts.absent > 0) {
    if (summaries.length === 0) return "DevLoadingView not found in module registry";
    summaries.push(`${counts.absent} reset${counts.absent === 1 ? "" : "s"} without DevLoadingView`);
  }
  return summaries.length > 0 ? summaries.join("; ") : "DevLoadingView not checked";
}
