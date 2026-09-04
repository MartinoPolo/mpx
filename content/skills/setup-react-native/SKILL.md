---
name: setup-react-native
description: Create a React and React Native monorepo from an authorized template
triggers: setting up an Expo React Native monorepo
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [work]
    defaultExposure: explicit-only
---

# Setup React Native

Read [the platform reference](PLATFORM_REFERENCE.md) before framework-rule setup.

## Launch identity

`<launch-identity>` is the immutable identity selected when MPX launched. Use it for every provider operation. If the launch identity is unavailable, stop and ask the user; never infer or substitute one.

## Workflow

1. Collect project name and visibility (private recommended). Do not expose credentials, machine paths, or private repository metadata in output.
2. Request `mpx tool invoke --capability repository.template-create --identity <launch-identity> --json` using `template-react-native-monorepo`. GitHub and GitLab may advertise different native template semantics; missing template support returns structured remediation and stops creation.
3. Create and push `dev` using ordinary `git -C <project-path>`. Request `mpx tool invoke --capability repository.default-branch --identity <launch-identity> --json` for `dev`.
4. Request `mpx tool invoke --capability repository.protection --identity <launch-identity> --json` for `main` and `dev`, requiring Review integration and CI. Record protection failures as accepted exceptions and continue.
5. Install with pnpm and run template-prescribed web/shared checks. Preserve full failing command evidence; continue only after confirming each failure does not make setup unusable.
6. Initialize canonical `.mpx/CONTEXT.md` and `.mpx/DECISIONS.md` without overwriting substantive content.
7. Follow the platform reference to link the central React rule. On failure, provide a platform-correct manual command and continue.
8. Commit and push authorized setup changes. Report repository URL, default branch, protection status, monorepo structure, check outcomes, framework rule state, and exceptions.

If a provider capability returns `CAPABILITY_UNSUPPORTED`, preserve confirmed local work, return structured remediation and a manual handoff, and do not fall back to any provider CLI.
