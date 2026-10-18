---
name: Bug report
about: Report a reproducible problem with SuperDSH
title: '[bug] '
labels: bug
assignees: ''
---

## Environment

- SuperDSH version:
- dsh version (`dsh --version`):
- Node/Bun version:
- OS:
- Profile: `core` / `coding` / `full` / custom flags

## What happened

A concise description and the smallest reproduction you can provide.

## Expected behavior

## Configuration

Paste the relevant plugin config (remove secrets and signing keys).

## Logs

Include the relevant `dsh --json` event lines or the SuperDSH tool error. If
the issue involves audit, effects, artifacts, memory, repairs, or knowledge,
include the store file names (not their contents if sensitive).

## Have you checked the limitations?

Review `README.md` → Known limitations and `docs/status.md`. Matters such as
advisory locks, opt-in repair memory, and non-durable budget are documented
there.
