import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTmuxLauncher } from "../../src/hosts/tmux.js";

const tmux = Bun.which("tmux");

describe("tmux launchers", () => {
  test("writes the launch command to a private executable script", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "megabrain-launcher-"));
    try {
      const created = await createTmuxLauncher(stateDir, "exec codex -- --brief 'long prompt'");
      expect(created.kind).toBe("ok");
      if (created.kind !== "ok") return;
      expect(await readFile(created.value, "utf8")).toBe("#!/bin/sh\nexec codex -- --brief 'long prompt'\n");
      expect((await stat(created.value)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test.if(tmux !== undefined)("starts a long argv intact without typing into a slow interactive shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-tmux-launch-"));
    const server = `mb-launch-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const session = `launch-${randomUUID().slice(0, 8)}`;
    const argsFile = join(root, "argv.json");
    const argsTempFile = join(root, "argv.tmp");
    const fakeAgent = join(root, "fake-agent.sh");
    const longArg = `brief:${"x".repeat(2048)}`;
    const delayedZsh = join(root, "slow-zsh.sh");
    try {
      await writeFile(fakeAgent, `#!/bin/sh\nprintf '%s\\n%s' "$#" "$1" > ${JSON.stringify(argsTempFile)}\nmv ${JSON.stringify(argsTempFile)} ${JSON.stringify(argsFile)}\n`, { mode: 0o700 });
      await writeFile(delayedZsh, "#!/bin/sh\nsleep 1\nexec /bin/zsh -i\n", { mode: 0o700 });
      const created = await createTmuxLauncher(root, `exec ${JSON.stringify(fakeAgent)} ${JSON.stringify(longArg)}`);
      expect(created.kind).toBe("ok");
      if (created.kind !== "ok") return;

      const createdSession = spawnSync(tmux!, ["-L", server, "new-session", "-d", "-s", session, "-c", root, "-e", `SHELL=${delayedZsh}`, created.value]);
      expect(createdSession.status).toBe(0);
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try { await stat(argsFile); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
      }
      expect(await readFile(argsFile, "utf8")).toBe(`1\n${longArg}`);
      const listed = spawnSync(tmux!, ["-L", server, "list-panes", "-a", "-F", "#{pane_current_command}"]);
      expect(listed.stdout.toString()).not.toContain("zsh");
    } finally {
      spawnSync(tmux!, ["-L", server, "kill-server"]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
