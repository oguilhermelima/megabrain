Pane frames used to judge the first prompt and later queued messages.

Captured live (private tmux server, real agents, 2026-10-11, then sanitised: blank lines and the Codex banner
removed, home directory shortened, quota numbers kept as they were):

- claude-idle, claude-unsubmitted, claude-working-draft, claude-queued, claude-delivered-idle: Claude Code 2.1.296 on Haiku 4.5.
- codex-idle, codex-unsubmitted, codex-working, codex-steered: Codex 0.162.1 on GPT-6-Luna.
- Codex also sets the pane title through OSC 0: a braille spinner prefix while a turn runs, none when idle.
  Verified live with tmux display-message -p '#{pane_title}'.

Not captured live:

- codex-queue-item: the "› 💬 ... / → full text: megabrain check" item that codex queue produces. The text comes from a
  past transcript (~/.megabrain/transcripts); a live attempt showed the message consumed as its own turn within a second,
  so the waiting frame was never on screen long enough to capture. The surrounding frame is assembled by hand.
