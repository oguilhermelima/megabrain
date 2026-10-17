# Desktop development

## Run the real app in a browser

Stage the CLI once, then run `bun run web` from this directory. The app opens at the Vite URL
(usually http://127.0.0.1:1420) and talks to the staged megabrain CLI and your normal
`~/.megabrain` state. The bridge listens only on loopback and creates a fresh token each run.
Stop the command to stop both Vite and the bridge. Terminals and choosing local folders need the
desktop app; the browser reports those limitations when requested.

Set `MEGABRAIN_CLI_PATH` to use a different CLI binary. `MEGABRAIN_STATE_DIR` selects the state
directory passed to the CLI and used for desktop attachment and trace files.

## Headless checks with a state copy

For automated checks, copy the state first and point the bridge at the copy. For example:

```sh
state_copy="$(mktemp -d)"
sqlite3 "$HOME/.megabrain/megabrain.db" ".backup $state_copy/megabrain.db"
cp -R "$HOME/.megabrain/chats" "$state_copy/chats"
cp -R "$HOME/.megabrain/knowledge" "$state_copy/knowledge"
MEGABRAIN_STATE_DIR="$state_copy" bun run web
```

The browser mode uses the normal app API against that copied state, so projects, knowledge, and
code views exercise the same CLI result shapes as the desktop app.
