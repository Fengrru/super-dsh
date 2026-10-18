# Release runbook

## Status

- Version: `0.1.0`
- Tag: `v0.1.0` (frozen; do not move it)
- GitHub release: <https://github.com/Fengrru/super-dsh/releases/tag/v0.1.0>
- npm: **not published yet** (`dsh-super@0.1.0` returns 404)
- Latest CI and Release workflow: see the badges in the README

## Repository metadata

Set on GitHub → repository → About:

- **Description:** `Safety-first reliability suite for DeepSeek Harness: tolerant edits, effects recovery, signed audit, content-addressed artifacts, tiered memory, repo map, and crash recovery.`
- **Topics:** `dsh`, `deepseek-harness`, `ai-agent`, `agent-reliability`, `typescript`, `plugin`, `memory`, `audit`, `crash-recovery`
- **Website:** the GitHub release page or the project blog index.

## Publish the npm package

The Release workflow skips npm publishing when `NPM_TOKEN` is empty, so the GitHub release can exist without a package. To publish:

1. Log in to npm as the package owner:
   ```sh
   npm login
   npm whoami
   ```
   The name `dsh-super` must be available (it was at the time of the first release).
2. Add an npm automation token to the GitHub repository as the `NPM_TOKEN` secret:
   - GitHub → Settings → Secrets and variables → Actions → New repository secret.
3. Run the **Release** workflow manually:
   - Actions → Release → Run workflow → tag `v0.1.0`.
   - The workflow checks out the tag, runs typecheck/tests/build/install smoke,
     publishes with provenance, and leaves the existing GitHub release in place.
4. Verify:
   ```sh
   npm view dsh-super@0.1.0 version
   npm pack dsh-super@0.1.0 --dry-run
   ```
5. In a clean `DSH_HOME`, install and call a tool:
   ```sh
   dsh plugin --profile headless add dsh-super
   dsh --profile headless --json "Use artifact_put to store 'release-ok' and artifact_verify the hash."
   ```

If npm publishing fails after the tag is moved or a new version is needed, **do not
move `v0.1.0`**. Bump to `0.1.1`, commit, tag, and publish that.

## Release invariants

- A published npm version is immutable; never reuse a version number.
- A published Git tag is immutable; never force-push it.
- The GitHub release and npm package must point at the same commit.
- Do not publish a package that skipped CI on its tag.
- `bun run smoke:install` must pass before publishing.

## Package contents

`npm pack --dry-run` should include:

- `dist/index.js`
- `cordis.patch.yml`
- `presets/`
- `scripts/install-smoke.ts`
- READMEs, CHANGELOG, license/notice/security/contributing docs
- `docs/` (including the blog collection)

The package has zero runtime dependencies; only the development toolchain
(TypeScript, Bun) is needed to build it.
