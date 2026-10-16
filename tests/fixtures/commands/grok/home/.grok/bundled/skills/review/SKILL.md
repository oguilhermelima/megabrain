---
name: review
description: >-
  Run a reviewer subagent against your whole branch vs main, your uncommitted
  working state, a named branch, a single GitHub PR, or an entire
  Graphite/stacked-PR stack (one reviewer subagent per PR). A bare /review
  defaults to reviewing your uncommitted working state when the tree is dirty,
  or your whole branch vs main when the tree is clean. Main, local, and
  branch modes write a review file plus a summary to disk. PR and stack modes
  post the findings as a PENDING GitHub review for the user to inspect and submit
  through the UI. Use --main for an explicit clean-tree branch review, --stack
  for stacked PRs, --submit to publish immediately as COMMENT, or --approve to
  publish and approve; the default remains PENDING.
when-to-use: "Use when asked to 'review', 'code review', 'review my changes', 'review my branch', 'review this PR', 'review a stack', '/review', '/review --main', '/review --stack', '/review --submit', or '/review --approve'."
argument-hint: "[--main | --local | --branch <name> | --pr <number-or-url> | --stack <number-or-url> | <auto-detect>] [--approve | --submit]"
---
Body
