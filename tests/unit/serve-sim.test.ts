import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServeSim } from "../../src/cli/commands/native/serve-sim.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

test("prefers the app's bundled serve-sim assets to repository installs and PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "serve-sim-resolution-")); roots.push(root);
  const executable = join(root, "Contents/MacOS/megabrain-cli");
  const bundled = join(root, "Contents/Resources/megabrain/serve-sim/dist/serve-sim.js");
  const local = join(root, "repo/node_modules/serve-sim/dist/serve-sim.js");
  await mkdir(join(root, "Contents/MacOS"), { recursive: true });
  await mkdir(join(root, "Contents/Resources/megabrain/serve-sim/dist"), { recursive: true });
  await mkdir(join(root, "repo/node_modules/serve-sim/dist"), { recursive: true });
  await writeFile(bundled, ""); await writeFile(local, "");

  expect(resolveServeSim({ MEGABRAIN_ROOT: join(root, "repo") }, executable, join(root, "repo"))).toEqual({
    command: executable,
    args: [bundled],
    env: { BUN_BE_BUN: "1" },
  });
});
