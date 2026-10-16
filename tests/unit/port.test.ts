import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";
import { canBind, portFree, portKill, portWho, type PortSystem } from "../../src/core/port.js";
import { failed, ok } from "../../src/core/result.js";

// Every test here runs against a fake lsof, ps, git and tmux. Nothing is signalled for real:
// the fake system records signals, and the only real socket is an ephemeral one.

const ME = 501;
const NOW = Date.parse("2026-10-16T12:00:00.000Z");

type Row = { pid: number; ppid: number; pgid: number; uid: number; etime: string; tty: string; args: string; cwd?: string; ports?: number[]; stubborn?: boolean };

const table: Row[] = [
  { pid: 1, ppid: 0, pgid: 1, uid: 0, etime: "10-00:00:00", tty: "??", args: "/sbin/launchd" },
  { pid: 500, ppid: 1, pgid: 500, uid: ME, etime: "01:00:00", tty: "??", args: "tmux -L megabrain-app new-session -d" },
  { pid: 600, ppid: 500, pgid: 600, uid: ME, etime: "30:00", tty: "ttys001", args: "-zsh" },
  { pid: 650, ppid: 600, pgid: 650, uid: ME, etime: "20:00", tty: "ttys001", args: "node host.js", ports: [7777] },
  { pid: 700, ppid: 600, pgid: 700, uid: ME, etime: "12:00", tty: "ttys001", args: "node /opt/pnpm/bin/pnpm run dev", cwd: "/work/canto-main" },
  { pid: 710, ppid: 700, pgid: 700, uid: ME, etime: "12:00", tty: "ttys001", args: "sh -c next dev", cwd: "/work/canto-main" },
  { pid: 720, ppid: 710, pgid: 700, uid: ME, etime: "12:00", tty: "ttys001", args: "node /work/canto-main/node_modules/.bin/next dev", cwd: "/work/canto-main" },
  { pid: 730, ppid: 720, pgid: 730, uid: ME, etime: "11:59", tty: "ttys001", args: "next-server (v15.0.0)", cwd: "/work/canto-main", ports: [3000] },
  { pid: 900, ppid: 1, pgid: 900, uid: 0, etime: "05:00:00", tty: "??", args: "/usr/sbin/httpd -D FOREGROUND", ports: [80] },
  { pid: 950, ppid: 1, pgid: 950, uid: ME, etime: "02:00:00", tty: "??", args: "redis-server *:6379", cwd: "/work/api", ports: [6379] },
  { pid: 1000, ppid: 650, pgid: 1000, uid: ME, etime: "00:01", tty: "ttys001", args: "node megabrain port kill" },
];

const command = (row: Row) => row.args.split(" ")[0]!.replace(/^-/, "").split("/").pop()!;

function fakeSystem(rows: Row[], environment: Record<string, string>) {
  const alive = new Set(rows.map((row) => row.pid));
  const signals: Array<[number, string | number]> = [];
  let clock = NOW;
  const live = () => rows.filter((row) => alive.has(row.pid));
  const processAdapter: ProcessAdapter = {
    invocationCount: () => 0,
    startDetached: async () => failed("not in tests"),
    async run(name, args) {
      const out = (stdout: string) => ok({ stdout, stderr: "", exitCode: 0 });
      if (name === "lsof") {
        if (args.includes("cwd")) {
          const pid = Number(args[args.indexOf("-p") + 1]);
          const row = live().find((item) => item.pid === pid);
          return row?.cwd === undefined ? failed("", 1, "") : out(`p${pid}\nfcwd\nn${row.cwd}\n`);
        }
        const single = args.find((arg) => arg.startsWith("-iTCP:"));
        const holders = live().filter((row) => (row.ports ?? []).length > 0 && (single === undefined || row.ports!.includes(Number(single.slice(6)))));
        if (holders.length === 0) return failed("", 1, "");
        if (single !== undefined) return out(holders.map((row) => `p${row.pid}\nc${command(row)}\nf20\nf21\n`).join(""));
        return out(holders.map((row) => `p${row.pid}\nf20\n${row.ports!.map((port) => `n*:${port}\n`).join("")}`).join(""));
      }
      if (name === "ps") return out(live().map((row) => `${row.pid} ${row.ppid} ${row.pgid} ${row.uid} ${row.etime} ${row.tty} ${row.args}`).join("\n") + "\n");
      if (name === "git") {
        const cwd = args[args.indexOf("-C") + 1];
        if (cwd !== "/work/canto-main") return failed("fatal: not a git repository", 128);
        if (args.includes("rev-parse")) return out("/work/canto-main\n/work/canto/.git\n");
        if (args.includes("branch")) return out("main\n");
      }
      if (name === "tmux") return out("mb-app-abc\t600\n");
      return failed(`${name}: unexpected in tests`, 127);
    },
  };
  const system: PortSystem = {
    process: processAdapter,
    environment,
    uid: ME,
    self: 1000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    canBind: async () => true,
    signal(pid, signal) {
      if (!alive.has(pid)) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      if (signal === 0) return;
      signals.push([pid, signal]);
      const row = rows.find((item) => item.pid === pid);
      if (signal === "SIGKILL" || row?.stubborn !== true) alive.delete(pid);
    },
  };
  return { system, signals, processAdapter };
}

let state = "";
let environment: Record<string, string> = {};

beforeEach(() => {
  state = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-port-")));
  environment = { HOME: join(state, "home"), MEGABRAIN_STATE_DIR: join(state, "state") };
  mkdirSync(environment.MEGABRAIN_STATE_DIR!, { recursive: true });
});
afterEach(() => rmSync(state, { recursive: true, force: true }));

describe("port who", () => {
  test("names the listener, its folder, its worktree, when it started and the app terminal it runs in", async () => {
    writeFileSync(join(environment.MEGABRAIN_STATE_DIR!, "app-terminals.json"), JSON.stringify({ "mb-app-abc": { title: "Run canto", command: "pnpm run dev", cwd: "/work/canto-main", createdAt: "2026-10-16T11:00:00.000Z" } }));
    const { system } = fakeSystem(table, environment);
    const result = await portWho(3000, system);
    expect(result).toEqual(ok({
      port: 3000,
      listeners: [{
        pid: 730,
        command: "next-server",
        args: "next-server (v15.0.0)",
        cwd: "/work/canto-main",
        startedAt: "2026-10-16T11:48:01.000Z",
        place: { root: "/work/canto-main", project: "canto", branch: "main" },
        managed: { kind: "app-terminal", session: "mb-app-abc", title: "Run canto" },
      }],
    }));
  });

  test("a megabrain proc whose pane holds the port is named", async () => {
    mkdirSync(join(environment.MEGABRAIN_STATE_DIR!, "procs", "k"), { recursive: true });
    writeFileSync(join(environment.MEGABRAIN_STATE_DIR!, "procs", "k", "redis.json"), JSON.stringify({ name: "redis", worktree: "/work/api", cwd: "/work/api", env: {}, command: ["redis-server"], json: false, owner: "x", session: "mb-proc-k-redis", pid: 950, startedAt: "2026-10-16T10:00:00.000Z", state: "running" }));
    const { system } = fakeSystem(table, environment);
    const result = await portWho(6379, system);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.value.listeners[0]).toMatchObject({ pid: 950, cwd: "/work/api", place: null, managed: { kind: "proc", name: "redis", worktree: "/work/api" } });
  });

  test("a free port has no listeners", async () => {
    const { system } = fakeSystem(table, environment);
    expect(await portWho(4999, system)).toEqual(ok({ port: 4999, listeners: [] }));
  });
});

describe("port free", () => {
  test("skips every port lsof lists as listening", async () => {
    const rows = [...table, { pid: 960, ppid: 1, pgid: 960, uid: ME, etime: "01:00", tty: "??", args: "node other.js", ports: [3001] }];
    const { system } = fakeSystem(rows, environment);
    expect(await portFree(3000, system)).toEqual(ok({ port: 3002 }));
  });

  test("skips a port it cannot bind even when lsof does not list it", async () => {
    const { system } = fakeSystem(table, environment);
    expect(await portFree(3000, { ...system, canBind: async (port) => port !== 3001 })).toEqual(ok({ port: 3002 }));
  });

  test("canBind sees a real listener on an ephemeral port", async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      expect(await canBind(address.port)).toBe(false);
      const { system } = fakeSystem([], environment);
      const free = await portFree(address.port, { ...system, canBind });
      expect(free.kind).toBe("ok");
      if (free.kind === "ok") expect(free.value.port).toBeGreaterThan(address.port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("port kill", () => {
  test("stops the top of the listener's tree, parent first, and leaves the interactive shell", async () => {
    const { system, signals } = fakeSystem(table, environment);
    const result = await portKill(3000, system);
    expect(result).toEqual(ok({ port: 3000, top: 700, stopped: [700, 710, 720, 730], freed: true }));
    expect(signals).toEqual([[700, "SIGTERM"], [710, "SIGTERM"], [720, "SIGTERM"], [730, "SIGTERM"]]);
  });

  test("refuses a listener owned by another user and signals nothing", async () => {
    const { system, signals } = fakeSystem(table, environment);
    const result = await portKill(80, system);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toContain("another user");
    expect(signals).toEqual([]);
  });

  test("refuses to stop a process megabrain itself runs under", async () => {
    const { system, signals } = fakeSystem(table, environment);
    const result = await portKill(7777, system);
    expect(result.kind).toBe("failed");
    expect(signals).toEqual([]);
  });

  test("a daemon with no terminal is stopped alone", async () => {
    const { system, signals } = fakeSystem(table, environment);
    expect(await portKill(6379, system)).toEqual(ok({ port: 6379, top: 950, stopped: [950], freed: true }));
    expect(signals).toEqual([[950, "SIGTERM"]]);
  });

  test("a listener that ignores SIGTERM gets SIGKILL", async () => {
    const rows = table.map((row) => (row.pid === 950 ? { ...row, stubborn: true } : row));
    const { system, signals } = fakeSystem(rows, environment);
    expect(await portKill(6379, system)).toEqual(ok({ port: 6379, top: 950, stopped: [950], freed: true }));
    expect(signals).toEqual([[950, "SIGTERM"], [950, "SIGKILL"]]);
  });

  test("nothing listening is an error", async () => {
    const { system, signals } = fakeSystem(table, environment);
    const result = await portKill(4999, system);
    expect(result.kind).toBe("failed");
    expect(signals).toEqual([]);
  });
});

describe("megabrain port", () => {
  test("who --json prints the listeners", async () => {
    const { processAdapter } = fakeSystem(table, environment);
    const result = await route(["port", "who", "6379", "--json"], { environment, processAdapter });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(JSON.parse(result.value)).toMatchObject({ port: 6379, listeners: [{ pid: 950, command: "redis-server" }] });
  });

  test("free --from --json on an ephemeral range", async () => {
    const rows = [...table, { pid: 960, ppid: 1, pgid: 960, uid: ME, etime: "01:00", tty: "??", args: "node other.js", ports: [49200] }];
    const { processAdapter } = fakeSystem(rows, environment);
    const result = await route(["port", "free", "--from", "49200", "--json"], { environment, processAdapter });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(JSON.parse(result.value).port).toBeGreaterThan(49200);
  });

  test("a missing or invalid port prints the usage", async () => {
    const { processAdapter } = fakeSystem(table, environment);
    for (const args of [["port", "kill"], ["port", "who", "http"], ["port", "who", "70000"]]) {
      const result = await route(args, { environment, processAdapter });
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.exitCode).toBe(2);
    }
  });
});
