import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectScriptPort } from "../../src/core/script-port.js";
import { route } from "../../src/cli/router.js";
import { createProcessAdapter } from "../../src/adapters/proc.js";

let root = "";

beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-script-port-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, scripts: Record<string, string>, extra: Record<string, unknown> = {}, files: Record<string, string> = {}): string {
  const directory = join(root, name);
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts, ...extra }));
  for (const [file, contents] of Object.entries(files)) writeFileSync(join(directory, file), contents);
  return directory;
}

describe("framework defaults through the package script", () => {
  const cases: ReadonlyArray<readonly [string, string, number, string | null]> = [
    ["next", "next dev", 3000, "--port {port}"],
    ["next-turbo", "next dev --turbopack", 3000, "--port {port}"],
    ["vite", "vite", 5173, "--port {port}"],
    ["vite-preview", "vite preview", 4173, "--port {port}"],
    ["astro", "astro dev", 4321, "--port {port}"],
    ["remix-vite", "remix vite:dev", 5173, "--port {port}"],
    ["remix", "remix dev", 3000, null],
    ["expo", "expo start --web", 8081, "--port {port}"],
    ["storybook", "storybook dev", 6006, "--port {port}"],
  ];
  for (const [name, script, port, override] of cases) {
    test(`${name}: ${script} listens on ${port}`, () => {
      const directory = project(name, { dev: script });
      expect(detectScriptPort(directory, "pnpm run dev")).toEqual({
        port, framework: expect.any(String), source: "default", detail: expect.stringContaining(String(port)), fragment: null, override,
      });
    });
  }

  test("npm start reaches the start script", () => {
    const directory = project("start", { start: "next start" });
    expect(detectScriptPort(directory, "npm start")?.port).toBe(3000);
  });
});

describe("explicit ports", () => {
  test("a --port flag in the run command wins and names the fragment to replace", () => {
    const directory = project("flag", { dev: "vite" });
    expect(detectScriptPort(directory, "vite --port 4000")).toEqual({
      port: 4000, framework: "vite", source: "command", detail: "--port 4000 in the run command", fragment: "--port 4000", override: "--port {port}",
    });
  });

  test("PORT= in the run command", () => {
    const directory = join(root, "bare");
    mkdirSync(directory);
    expect(detectScriptPort(directory, "PORT=5000 node server.js")).toMatchObject({ port: 5000, source: "command", fragment: "PORT=5000", framework: null });
  });

  test("-p in the package script fixes the port and leaves no flag to override with", () => {
    const directory = project("storybook-p", { storybook: "storybook dev -p 6007" });
    expect(detectScriptPort(directory, "bun run storybook")).toMatchObject({ port: 6007, source: "script", override: null, fragment: null });
  });

  test("PORT= in the package script can still be overridden by the framework flag", () => {
    const directory = project("next-env", { dev: "PORT=3100 next dev" });
    expect(detectScriptPort(directory, "yarn dev")).toMatchObject({ port: 3100, source: "script", framework: "next", override: "--port {port}" });
  });
});

describe("environment files and package.json", () => {
  test(".env PORT applies to a framework that reads PORT", () => {
    const directory = project("next-dotenv", { dev: "next dev" }, {}, { ".env": "# comment\nPORT=4100\nOTHER=1\n" });
    expect(detectScriptPort(directory, "pnpm run dev")).toMatchObject({ port: 4100, source: "env-file", detail: expect.stringContaining(".env") });
  });

  test(".env.local wins over .env", () => {
    const directory = project("next-local", { dev: "next dev" }, {}, { ".env": "PORT=4100\n", ".env.local": "PORT=\"4200\"\n" });
    expect(detectScriptPort(directory, "pnpm run dev")?.port).toBe(4200);
  });

  test(".env PORT is ignored by a framework that does not read it", () => {
    const directory = project("vite-dotenv", { dev: "vite" }, {}, { ".env": "PORT=4100\n" });
    expect(detectScriptPort(directory, "pnpm run dev")).toMatchObject({ port: 5173, source: "default" });
  });

  test("package.json config.port for an unknown server", () => {
    const directory = project("config", { dev: "node server.js" }, { config: { port: 8088 } });
    expect(detectScriptPort(directory, "npm run dev")).toMatchObject({ port: 8088, source: "package-json", framework: null, override: null });
  });
});

describe("commands outside package.json", () => {
  test("rails server defaults to 3000 with -p", () => {
    const directory = join(root, "rails");
    mkdirSync(directory);
    expect(detectScriptPort(directory, "bin/rails server")).toMatchObject({ port: 3000, framework: "rails", override: "-p {port}" });
  });

  test("django runserver defaults to 8000 and takes the port as a positional argument", () => {
    const directory = join(root, "django");
    mkdirSync(directory);
    expect(detectScriptPort(directory, "python manage.py runserver")).toMatchObject({ port: 8000, framework: "django", override: "{port}" });
    expect(detectScriptPort(directory, "python manage.py runserver 0.0.0.0:8001")).toMatchObject({ port: 8001, source: "command", fragment: "0.0.0.0:8001" });
  });
});

describe("unknown", () => {
  test("an unknown server with nothing to go on stays null", () => {
    const directory = project("unknown", { dev: "node server.js" });
    expect(detectScriptPort(directory, "npm run dev")).toBeNull();
  });

  test("no command, no port", () => {
    expect(detectScriptPort(root, null)).toBeNull();
  });

  test("a build script does not bind", () => {
    const directory = project("build", { build: "vite build" });
    expect(detectScriptPort(directory, "pnpm run build")).toBeNull();
  });
});

describe("repo scripts --json", () => {
  test("reports the port the run command binds next to the scripts", async () => {
    const directory = project("cli", { dev: "next dev" });
    const env = { HOME: join(root, "home"), MEGABRAIN_STATE_DIR: join(root, "state") };
    mkdirSync(env.HOME);
    expect((await createProcessAdapter().run("git", ["init", "-b", "main"], { cwd: directory })).kind).toBe("ok");
    const result = await route(["repo", "scripts", directory, "--json"], { environment: env, processAdapter: createProcessAdapter() });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(JSON.parse(result.value).port).toMatchObject({ port: 3000, framework: "next", source: "default" });
  });
});
