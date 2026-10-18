# Release runbook

## Status

- Version: `0.2.0`
- Tag: `v0.2.0` (frozen)
- GitHub release: <https://github.com/Fengrru/super-dsh/releases/tag/v0.2.0>
- Distribution: **GitHub only; no npm registry publication**
- Latest CI and Release workflow: see the badges in the README

## Repository metadata

Set on GitHub → repository → About:

- **Description:** `Safety-first reliability suite for DeepSeek Harness: tolerant edits, effects recovery, signed audit, content-addressed artifacts, tiered memory, repo map, and crash recovery.`
- **Topics:** `dsh`, `deepseek-harness`, `ai-agent`, `agent-reliability`, `typescript`, `plugin`, `memory`, `audit`, `crash-recovery`
- **Website:** the GitHub release page or a project website.

## Distribution policy

SuperDSH is installed from a Git checkout or a local tarball; the project has
decided **not to publish to npm**.

- `package.json` is marked `"private": true` so an accidental `npm publish`
  cannot create a registry release.
- The release workflow creates a GitHub release only. It does not require an
  `NPM_TOKEN`.
- `npm pack` remains a local packaging/test command. `bun run smoke:install`
  uses it to verify that the file set installs through `dsh plugin add`.

## Release workflow

1. Ensure CI passes on the commit.
2. Update `CHANGELOG.md` and the version in `package.json`.
3. Run the local gates:
   ```sh
   bun run typecheck
   bun test
   bun run build
   bun run smoke:install
   ```
4. Commit, create an annotated tag, and push both:
   ```sh
   git tag -a vX.Y.Z -m "SuperDSH X.Y.Z"
   git push origin master
   git push origin vX.Y.Z
   ```
5. The Release workflow checks out the tag, runs the same gates, and creates a
   GitHub release. It can also be run manually with the tag input.

## Release invariants

- A published Git tag is immutable; do not force-push it.
- The GitHub release and tag must point at the same commit.
- Do not release a commit whose tag CI did not pass.
- `bun run smoke:install` must pass before tagging.
- No npm registry publication; do not add `NPM_TOKEN` or an `npm publish` step.

## Package contents

`npm pack --dry-run` should include:

- `dist/index.js`
- `cordis.patch.yml`
- `presets/`
- `scripts/install-smoke.ts`
- READMEs, CHANGELOG, license/notice/security/contributing docs
- `docs/` (project documentation)

The package has zero runtime dependencies; only the development toolchain
(TypeScript, Bun) is needed to build it.
