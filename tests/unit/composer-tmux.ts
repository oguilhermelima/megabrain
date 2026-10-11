import { readFileSync } from "node:fs";
import type { ProcessOutput } from "../../src/adapters/proc.js";
import { ok, type Result } from "../../src/core/result.js";

// A stateful stand-in for an agent's composer behind the tmux provider. It renders the same
// shapes the real agents drew in the captured fixtures (tests/fixtures/composer): short text
// inline, long text collapsed into a placeholder, nothing at all once a turn is running.

export type ComposerPaneOptions = Readonly<{
  agent: "codex" | "claude";
  events?: string[];
  // The first N pastes arrive as only their last tailBytes bytes, as a swallowed paste does.
  swallowPastes?: number;
  tailBytes?: number;
  // The first N Enter presses with text in the composer do nothing.
  ignoreEnters?: number;
  // What the pane shows once the prompt is submitted: a running turn, or an idle composer again.
  afterSubmit?: "working" | "idle";
  // Called with the submitted prompt, the way a child would answer with megabrain received.
  onSubmit?: (prompt: string) => void;
  // Called before the prompt reaches the composer; returning "swallow" drops it entirely.
  onPaste?: (text: string) => "swallow" | undefined;
}>;

export type ComposerPane = Readonly<{
  provider: Readonly<{
    capturePane: () => Promise<Result<string>>;
    sendText: (pane: string, text: string) => Promise<Result<void>>;
    pasteText: (pane: string, text: string) => Promise<Result<void>>;
    sendKey: (pane: string, key: string) => Promise<Result<void>>;
  }>;
  pastes: string[];
  submissions: string[];
  draft: () => string;
  working: () => boolean;
  setWorking: (value: boolean) => void;
}>;

const COLLAPSE_AT_CHARS = 1000;

function utf8Tail(text: string, bytes: number): string {
  const encoded = new TextEncoder().encode(text);
  return new TextDecoder().decode(encoded.slice(Math.max(0, encoded.length - bytes)));
}

// The screen an idle agent draws around whatever its composer currently holds.
export function composerView(agent: "codex" | "claude", draft: string): string {
  const claude = agent === "claude";
  const glyph = claude ? "❯" : "›";
  let line: string;
  if (draft === "") {
    line = claude ? "❯ Try \"edit module-orchestrate.sh to...\"" : "› Ask Codex to do anything";
  } else if (draft.length > COLLAPSE_AT_CHARS) {
    const lines = draft.split("\n").length - 1;
    const placeholder = claude ? (lines === 0 ? "[Pasted text #1]" : `[Pasted text #1 +${lines} lines]`) : `[Pasted Content ${[...draft].length} chars]`;
    line = `${glyph} ${placeholder}`;
  } else {
    line = draft.split("\n").map((row, index) => (index === 0 ? `${glyph} ${row}` : `  ${row}`)).join("\n");
  }
  return claude ? `──────\n${line}\n──────\n  Haiku 5.5 1M (Low)\n` : `${line}\n  GPT-6-Luna medium · Context 100% left\n`;
}

export function composerPane(options: ComposerPaneOptions): ComposerPane {
  const events = options.events ?? [];
  const pastes: string[] = [];
  const submissions: string[] = [];
  let draft = "";
  let working = false;
  let swallow = options.swallowPastes ?? 0;
  let ignoreEnters = options.ignoreEnters ?? 0;
  const claude = options.agent === "claude";

  function render(): string {
    if (working) {
      return claude
        ? `✻ Working · thinking\nesc to interrupt\n──────\n❯\n──────\n`
        : `• Working (1s • esc to interrupt)\nesc to interrupt\n› \n`;
    }
    return composerView(options.agent, draft);
  }

  function type(text: string, how: "paste" | "send-keys"): Result<void> {
    if (text.includes("MEGABRAIN_DISPATCH_ID=")) {
      events.push("launch");
      return ok(undefined);
    }
    pastes.push(text);
    events.push(how);
    if (options.onPaste?.(text) === "swallow") return ok(undefined);
    if (swallow > 0) {
      swallow -= 1;
      draft = utf8Tail(text, options.tailBytes ?? 400);
    } else {
      draft = text;
    }
    return ok(undefined);
  }

  return {
    pastes,
    submissions,
    draft: () => draft,
    working: () => working,
    setWorking: (value) => { working = value; },
    provider: {
      capturePane: async () => ok(render()),
      sendText: async (_pane, text) => type(text, "send-keys"),
      pasteText: async (_pane, text) => type(text, "paste"),
      sendKey: async (_pane, key) => {
        events.push(`key:${key}`);
        if (key === "C-u") {
          draft = "";
        } else if (key === "Enter" && draft !== "") {
          if (ignoreEnters > 0) {
            ignoreEnters -= 1;
          } else {
            submissions.push(draft);
            const submitted = draft;
            draft = "";
            working = options.afterSubmit !== "idle";
            options.onSubmit?.(submitted);
          }
        }
        return ok(undefined);
      },
    },
  };
}

// The provider overrides most spawn tests need: a pane whose composer shows what was pasted into it.
export function composerTmux(options: Partial<ComposerPaneOptions> = {}): ComposerPane["provider"] {
  return composerPane({ agent: "codex", ...options }).provider;
}

// The same composer behind a fake tmux process, for tests that exercise the real tmux provider: a
// paste goes through load-buffer then paste-buffer, keys and literal text arrive via send-keys,
// and capture-pane draws the composer. Returns undefined for any other command.
export function composerProcess(options: Partial<ComposerPaneOptions> = {}): (command: string, args: readonly string[]) => Promise<Result<ProcessOutput> | undefined> {
  const pane = composerPane({ agent: "codex", ...options });
  let loaded = "";
  const done = (stdout = ""): Result<ProcessOutput> => ok({ stdout, stderr: "", exitCode: 0 });
  return async (command, args) => {
    if (command !== "tmux") return undefined;
    if (args[0] === "capture-pane") {
      const screen = await pane.provider.capturePane();
      return screen.kind === "ok" ? done(screen.value) : undefined;
    }
    if (args[0] === "load-buffer") {
      loaded = readFileSync(args[args.length - 1] ?? "", "utf8");
      return done();
    }
    if (args[0] === "paste-buffer") {
      await pane.provider.pasteText("%9", loaded);
      return done();
    }
    if (args[0] === "send-keys") {
      const literal = args.includes("-l");
      const value = args[args.length - 1] ?? "";
      if (literal) await pane.provider.sendText("%9", value);
      else await pane.provider.sendKey("%9", value);
      return done();
    }
    return undefined;
  };
}

type Sends = Readonly<{
  sendText: (pane: string, text: string, ...rest: never[]) => Promise<Result<void>>;
  sendKey: (pane: string, key: string, ...rest: never[]) => Promise<Result<void>>;
  capturePane: (...args: never[]) => Promise<Result<string>>;
}>;

// Gives a tmux fake that only knows sendText the paste the spawn now uses: the prompt still goes
// through the fake's own sendText (so its recording keeps working), and the pane then shows it in
// the composer until Enter or C-u clears it.
export function withComposer<T extends Sends>(fake: T, agent: "codex" | "claude" = "codex"): T & { pasteText: (pane: string, text: string, ...rest: unknown[]) => Promise<Result<void>> } {
  let pasted = "";
  const sendText = fake.sendText as (pane: string, text: string, ...rest: unknown[]) => Promise<Result<void>>;
  const sendKey = fake.sendKey as (pane: string, key: string, ...rest: unknown[]) => Promise<Result<void>>;
  const capturePane = fake.capturePane as (...args: unknown[]) => Promise<Result<string>>;
  return {
    ...fake,
    pasteText: async (pane, text, ...rest) => {
      const result = await sendText(pane, text, ...rest);
      if (result.kind === "ok") pasted = text;
      return result;
    },
    sendKey: async (pane: string, key: string, ...rest: unknown[]) => {
      if (key === "Enter" || key === "C-u") pasted = "";
      return sendKey(pane, key, ...rest);
    },
    capturePane: async (...args: unknown[]) => (pasted !== "" ? ok(composerView(agent, pasted)) : capturePane(...args)),
  };
}
