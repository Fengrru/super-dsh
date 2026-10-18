# Contributing to SuperDSH

SuperDSH is a dsh plugin with a deliberately small runtime: one ESM bundle and
zero production dependencies. Contributions are welcome, but the project's
evidence rule applies to code as much as to features.

## Setup

```sh
bun install
bun run typecheck
bun test
bun run build
bun run smoke:install
```

The full agent experiments require a sibling `deepseek-harness` checkout and a
`DEEPSEEK_API_KEY`. Deterministic tests do not.

## Evidence rule

A new capability becomes a default only when a pre-registered experiment
supports it and its guardrails do not regress. For a change:

1. State the hypothesis and decision rule before running it.
2. Add deterministic tests for the guarantees.
3. If it changes model behavior, add or extend an agent-level A/B and record
   the raw result in `experiments/results/`.
4. Update `docs/experiments.md`, `docs/status.md`, and `docs/decisions.md`.
5. If the result is null, prefer opt-in or removal over a weak default.

Do not add a tool to the default profile based only on a synthetic benchmark.
Repair memory is the current example of a feature that stayed implemented but
moved to opt-in after its A/B was null.

## Code conventions

- TypeScript ESM, Node built-ins only in `src/`; do not add runtime
  dependencies.
- Tool schemas must remain inside dsh's supported JSON-Schema subset. The
  schema guard in `tests/schema.test.ts` catches unsupported keywords.
- Keep filesystem writes atomic where a rewrite is possible (temp file +
  rename), and hold the existing advisory lock for shared read-modify-write
  stores.
- Errors in optional features must be isolated; one feature must not take down
  the harness.
- Match the existing style: two-space indentation, single quotes, no
  semicolons.

## Pull requests

Include:

- the problem and the smallest change that addresses it;
- tests for new behavior and failure paths;
- experiment results and the decision rule when a default changes;
- documentation updates for user-visible behavior or limitations;
- `bun test`, `bun run typecheck`, `bun run build`, and `bun run smoke:install`
  outcomes.

## Security

Do not open a public issue for a vulnerability. Follow
[SECURITY.md](SECURITY.md). Capability tokens, file locks, and the worker
protocol are libraries, not a sandbox; do not describe them as one.

## Releases

Release tags use `vX.Y.Z`. The GitHub Actions release workflow runs the test,
typecheck, build, and install smoke, publishes to npm, and creates a GitHub
release. It requires an `NPM_TOKEN` repository secret and a published
`dsh-super` package name. The workflow does not run on ordinary pushes.

## License

By contributing, you agree that your contribution is licensed under the MIT
License in [LICENSE](LICENSE).
