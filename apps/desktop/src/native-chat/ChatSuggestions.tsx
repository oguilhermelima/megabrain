import { useEffect, useState } from "react";
import { api } from "@/api";

// A new chat with nothing said yet: a few things to ask in this worktree instead of a spinner. The
// agent waits for the first message anyway, so there is nothing to load before it.

const basename = (path: string) => path.split("/").at(-1) ?? path;

/** The suggestions for a worktree; one names a file it changed, when there is one. */
export function chatSuggestions(changedFile: string | null): string[] {
  return [
    "Explain this repo",
    "Find bugs in the last commit",
    changedFile === null
      ? "Write tests for the code I changed last"
      : `Write tests for ${changedFile}`,
    "Summarise the open pull requests",
  ];
}

/** The empty chat: a line on what to do and the suggestions; picking one fills the composer. */
export function ChatSuggestions({
  cwd,
  agent,
  onPick,
}: {
  cwd: string;
  agent: string;
  onPick: (text: string) => void;
}) {
  const [changed, setChanged] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    api.codeChanges(cwd).then(
      (changes) => {
        const file = changes.find((change) => change.status !== "deleted");
        if (current && file !== undefined) setChanged(file.path);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [cwd]);
  return (
    <div className="mx-8 my-auto flex flex-col items-center gap-4 py-10 text-center">
      <p className="text-[14px] text-ink-300">
        Ask {agent} anything about{" "}
        <span className="font-medium text-ink-100">{basename(cwd)}</span>, or
        start from one of these:
      </p>
      <div className="flex max-w-[560px] flex-wrap justify-center gap-2">
        {chatSuggestions(changed).map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onPick(text)}
            className="rounded-full border border-white/[0.1] bg-white/[0.04] px-3.5 py-1.5 text-[12.5px] text-ink-200 transition-colors hover:bg-white/[0.1] hover:text-ink-100"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
