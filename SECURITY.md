# Security

## Reporting

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability** flow on the repository. Do not open a public issue for a security problem.

Include the affected version, a minimal reproduction, and the impact. We will acknowledge within 5 business days.

## Scope and threat model

SuperDSH runs **inside** the dsh process with the same privileges as the harness. It is not a sandbox, an authorization layer, or a substitute for dsh's approval and sandbox policies.

- `fuzzy_edit` goes through dsh's `ctx.fs.editText`, including the read-before-edit policy and any mounted sandbox policy. It intentionally refuses edits it cannot prove target the intended block.
- The verification gate executes a **configured shell command** from the session's working directory. Configure only commands you would run yourself. On Windows it terminates the process tree with `taskkill`; on POSIX it uses a process group.
- Project memory is stored as plaintext JSONL under `$DSH_HOME/super-dsh/memory/`. It may contain project details or user preferences. Protect the harness home directory; do not store credentials or secrets in memory entries. Retrieved memories are injected as **data**, but a malicious repository can still attempt to poison them. Review the store if you work with untrusted repositories.
- The audit ledger is **unkeyed by default**. It detects accidental or naive edits, deletions, truncation, and reordering. Optional HMAC-SHA256 signing (`audit.signingKeyEnv`/`signingKey`) binds each record hash to a key, but the key is the operator's responsibility; anyone with the key can still forge a consistent ledger. For adversarial integrity, also ship the ledger to an append-only/WORM store.
- `apply_patch` file locks are **advisory** and local-filesystem only. Host `write`/`edit`, external editors, different lock directories, symlink aliases, and network filesystems can bypass them. They prevent cooperating SuperDSH calls from overlapping, not a determined process.
- Capability tokens, the causal clock, and the worker protocol are libraries. No remote worker or network service is included; do not treat the library as a running authorization boundary.
- The plugin has **zero runtime dependencies**; the published bundle imports only Node built-ins. Build from source only from a commit you trust, and review changes to the vendored `src/vendor/fuzzy-patch.ts`.

## Supported versions

Security fixes target the latest release on the default branch. dsh itself is pre-stable; compatibility is validated against the version stated in the README.
