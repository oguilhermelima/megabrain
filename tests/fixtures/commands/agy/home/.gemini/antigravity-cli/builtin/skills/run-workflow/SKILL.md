---
name: run-workflow
description: >-
  How to write and run a dynamic workflow script with the `run_workflow` tool:
  a Python script that orchestrates many agents with `agent`, `parallel`,
  `pipeline`, and `phase`. Use when a task splits into many
  independent or staged pieces of agent work (fan out over files, modules,
  bugs, or review angles, then aggregate), or when the user asks for a
  workflow. Don't use for a single delegated task (use a subagent) or for
  legacy workflow files (see migrate-workflows).
---
Body
