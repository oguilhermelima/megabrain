import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

const LIMIT = 800;

// Keep these ceilings exact so each exception disappears as soon as its file is split.
const exceptions: Readonly<Record<string, number>> = {
  "apps/desktop/src/advanced/Advanced.tsx": 922,
  "apps/desktop/src-tauri/src/terminal.rs": 924,
  "src/cli/commands/projects.ts": 903,
  "apps/desktop/src/advanced/Sidebar.tsx": 823,
};

function trackedSourceFiles(): string[] {
  const files = execFileSync("git", ["ls-files", "-z", "src", "apps/desktop/src", "apps/desktop/src-tauri/src"], {
    encoding: "utf8",
  }).split("\0").filter(Boolean);

  return files.filter((file) => {
    const inScope = /^src\/.*\.ts$/.test(file)
      || /^apps\/desktop\/src\/.*\.tsx?$/.test(file)
      || /^apps\/desktop\/src-tauri\/src\/.*\.rs$/.test(file);
    const excluded = /\.test\.tsx?$/.test(file)
      || /(?:^|\/)(?:__fixtures__|fixtures?|generated|__generated__)(?:\/|$)/i.test(file)
      || /(?:\.generated|\.gen)\.[^/]+$/.test(file);
    return inScope && !excluded;
  });
}

async function lineCount(file: string): Promise<number> {
  const contents = await readFile(file, "utf8");
  return contents === "" ? 0 : contents.split(/\r\n|\n|\r/).length - (/(\r\n|\n|\r)$/.test(contents) ? 1 : 0);
}

describe("source file size ratchet", () => {
  test("keeps tracked source files within the line limit or at an explicit ceiling", async () => {
    const files = trackedSourceFiles();
    const tracked = new Set(files);
    const failures: string[] = [];

    for (const [file, ceiling] of Object.entries(exceptions)) {
      if (!tracked.has(file)) {
        failures.push(`${file}: count unavailable because the exception file is missing; limit ${ceiling}`);
      }
    }

    for (const file of files) {
      const count = await lineCount(file);
      const ceiling = exceptions[file];
      if (ceiling !== undefined) {
        if (count > ceiling) failures.push(`${file}: ${count} lines exceeds exception limit ${ceiling}`);
        else if (count <= LIMIT) failures.push(`${file}: ${count} lines is at or under limit ${LIMIT}; remove the exception`);
        else if (count < ceiling) failures.push(`${file}: ${count} lines is below exception limit ${ceiling}; lower the exception ceiling`);
      } else if (count > LIMIT) {
        failures.push(`${file}: ${count} lines exceeds limit ${LIMIT}`);
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });
});
