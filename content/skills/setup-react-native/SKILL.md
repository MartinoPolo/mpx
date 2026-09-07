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

Provider operations follow [the shared provider resolution and native command references](../shared/ISSUE_TRACKER.md).

Read [the platform reference](PLATFORM_REFERENCE.md) before framework-rule setup.

## Workflow

1. Collect project name and visibility (private recommended). Do not expose credentials, machine paths, or private repository metadata in output.
2. Request the resolved provider reference’s documented native operation with an explicit target using `template-react-native-monorepo`. GitHub and GitLab may advertise different native template semantics; missing template support returns structured remediation and stops creation.
3. Create and push `dev` using ordinary `git -C <project-path>`. Request the resolved provider reference’s documented native operation with an explicit target for `dev`.
4. Request the resolved provider reference’s documented native operation with an explicit target for `main` and `dev`, requiring Review integration and CI. Record protection failures as accepted exceptions and continue.
5. Install with pnpm and run template-prescribed web/shared checks. Preserve full failing command evidence; continue only after confirming each failure does not make setup unusable.
6. Initialize canonical `.mpx/CONTEXT.md` and `.mpx/DECISIONS.md` without overwriting substantive content.
7. Follow the platform reference to link the central React rule. On failure, provide a platform-correct manual command and continue.
8. Commit and push authorized setup changes. Report repository URL, default branch, protection status, monorepo structure, check outcomes, framework rule state, and exceptions.

If a provider capability returns `CAPABILITY_UNSUPPORTED`, preserve confirmed local work, return structured remediation and a manual handoff, and do not fall back to any provider CLI.
