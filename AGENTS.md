# MPX project instructions

MPX is a private-first TypeScript monorepo that provides one CLI and shared contracts for Claude Code, Pi, providers, ports, worktrees, sessions, and installation.

## Architecture

- Keep domain logic in workspace packages and runtime adapters thin.
- Treat `mpxconfig.json` as the only committed project integration manifest.
- Keep generated machine state outside Git.
- Use provider-neutral Issue, Review, and CI contracts.
- Emit stable versioned JSON envelopes from automation-capable CLI commands.
- Fail closed on unknown schema versions, stale artifacts, ambiguous identities, and untrusted automation.
- Do not add permanent readers for legacy MPX configuration.

## Implementation

- Use portable TypeScript and Node ESM by default.
- Use focused PowerShell only for Windows-native operations and return structured JSON.
- Keep packages private unless publication is explicitly designed and validated.
- Resolve cross-package behavior through workspace APIs, never absolute repository imports.
- Add narrow tests for domain behavior and malicious inputs.
- Separate independent top-level constants, types, functions, and test scenarios with one blank line; tightly coupled declarations may remain grouped.
- Preserve existing installations and data until the migration acceptance gates pass.

## Runtime content

- Canonical skills use bare identities under `content/skills`.
- The public runtime namespace is `/mpx:<skill>`.
- Skill bodies remain lazy and are projected from one resolved manifest.
- Canonical content must not contain runtime-specific placeholders or absolute machine paths.
