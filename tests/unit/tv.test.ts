import { expect, test } from "bun:test";
import { parseTv, tvConnectOutput, tvUsage } from "../../src/core/tv.js";

test("parses tv connect and disconnect", () => {
  expect(parseTv(["connect", "10.0.0.2", "--port", "1234"])).toEqual({ kind: "ok", value: { operation: "connect", ip: "10.0.0.2", port: "1234" } });
  expect(parseTv(["disconnect"])).toEqual({ kind: "ok", value: { operation: "disconnect", port: "5555" } });
  expect(parseTv(["connect"]).kind).toBe("failed");
  expect(tvConnectOutput("x:5555", "device")).toEqual({ kind: "ok", value: "tv: connected (x:5555)\n" });
  expect(tvConnectOutput("x:5555", "").kind).toBe("failed");
  expect(tvUsage()).toContain("tv connect");
});
