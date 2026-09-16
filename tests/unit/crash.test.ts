import { describe, expect, test } from "bun:test";
import { parseCrashReport, selectCrashReports } from "../../src/core/crash.js";

const report = [
  JSON.stringify({ app_name: "ExampleApp", app_version: "1.2", bug_type: "309", incident_id: "abc", os_version: "macOS", timestamp: "2026-09-16 01:02:03" }),
  JSON.stringify({
    exception: { type: "EXC_CRASH", signal: "SIGABRT", codes: "0x0" },
    termination: { indicator: "Abort trap: 6" },
    faultingThread: 0,
    threads: [{ frames: [{ imageIndex: 0, imageOffset: "0x10" }, { imageIndex: 1, imageOffset: "0x20" }] }],
    usedImages: [{ name: "ExampleApp", path: "/Applications/ExampleApp.app/ExampleApp" }, { name: "libsystem", path: "/usr/lib/libsystem.dylib" }],
    codeSigningID: "com.example.app",
  }),
].join("\n");

describe("crash report parsing and selection", () => {
  test("extracts a report and resolves image indexes without symbols", () => {
    expect(parseCrashReport(report, "com.example.app")).toEqual({
      kind: "report",
      value: {
        appName: "ExampleApp", appVersion: "1.2", incidentId: "abc", timestamp: "2026-09-16 01:02:03",
        exceptionType: "EXC_CRASH", signal: "SIGABRT", termination: "Abort trap: 6",
        frames: [
          "ExampleApp + 0x10 (/Applications/ExampleApp.app/ExampleApp)",
          "libsystem + 0x20 (/usr/lib/libsystem.dylib)",
        ],
      },
    });
  });

  test("rejects a header-only file", () => {
    const result = parseCrashReport(JSON.stringify({ app_name: "ExampleApp" }), "ExampleApp");
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toContain("body");
  });

  test("reports invalid body JSON", () => {
    const result = parseCrashReport('{"app_name":"ExampleApp"}\nnot json', "ExampleApp");
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toContain("JSON");
  });

  test("does not select a report for a different app", () => {
    expect(parseCrashReport(report, "com.other.app")).toEqual({ kind: "no-match" });
  });

  test("rejects a faulting thread index that is absent", () => {
    const result = parseCrashReport(report.replace('"faultingThread":0', '"faultingThread":4'), "com.example.app");
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toContain("faultingThread");
  });

  test("selects matching contents in newest-first order and honors last", () => {
    const selected = selectCrashReports([
      { path: "old.ips", contents: report, modifiedAt: 10 },
      { path: "other.ips", contents: report.replace("ExampleApp", "OtherApp").replace("com.example.app", "com.other.app"), modifiedAt: 30 },
      { path: "new.ips", contents: report, modifiedAt: 20 },
    ], "com.example.app", 1);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.path).toBe("new.ips");
  });
});
