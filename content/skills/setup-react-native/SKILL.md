---
name: setup-react-native
description: Create a React and Expo React Native monorepo from the authorized GitHub template
triggers: setting up an Expo React Native monorepo
metadata:
  author: MartinoPolo
  version: '0.6'
  category: setup
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# Setup React Native Monorepo

Read [PLATFORM_REFERENCE](PLATFORM_REFERENCE.md) and
[provider routing](../shared/PROVIDER_ROUTING.md). Resolve linked files relative to this loaded
skill. For absolute reads, follow [Content Paths](../shared/CONTENT_PATHS.md).

Because the destination and its `mpxconfig.json` do not exist yet, take the **repository provider as
explicit setup input** (GitHub is the deliberate template source, but is not an automatic fallback).
Read that provider's native guide under `../shared/providers/`. Use native provider commands only
where the guide documents the behavior; never invent an MPX command or derive this choice from
another project's configuration. Preserve the immutable launch identity and account-bound CLI
environment.

## Workflow

### 1. Inputs and destination

Get the project name and repository provider from invocation input or ask for them. Ask visibility
(`private` recommended, or `public`). Resolve the destination under an available `MPX_PROJECTS` or
`MPX_WORK`, or use an explicit user path. Fail naming the missing variable rather than guessing a
machine root.

### 2. Create from template

For GitHub, resolve the authenticated account and create from its template:

```bash
gh api user --jq .login
gh repo create <project-name> --template <github-user>/template-react-native-monorepo --public|--private --clone
```

Discover the template with the selected provider's documented native metadata command before
creation (for GitHub,
`gh repo view <github-user>/template-react-native-monorepo --json nameWithOwner,isTemplate,url`). If
it is absent or is not marked as a template, report `<user>/template-react-native-monorepo` and
stop. If another selected provider's native guide documents equivalent template creation, follow it.
Otherwise stop with a manual handoff; do not emulate native template semantics or switch providers.

### 3. Branches and policy

```bash
git -C <project-path> checkout -b dev
git -C <project-path> push -u origin dev
```

Set the default branch only through the selected provider guide. For GitHub:

```bash
gh repo edit <owner/project-name> --default-branch dev
```

For another provider, stop with a manual handoff when its guide does not document default-branch
changes. For GitHub, protect `main` and `dev` with the native API:

```bash
gh api repos/<owner>/<project-name>/branches/<branch>/protection --method PUT --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["ci"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0
  },
  "restrictions": null
}
EOF
```

Repeat for both branches. A protection failure is an accepted exception: preserve the complete
error, identify the unprotected branch, and continue. A creation failure stops setup; a
default-branch failure preserves pushed branches and becomes a manual handoff.

### 4. Install and verify

```bash
pnpm --dir <project-path> install
pnpm --dir <project-path> --filter web run check:all
pnpm --dir <project-path> --filter shared run check:all
```

Preserve every failing command and complete output. Continue only when checks pass or every failure
is recorded and confirmed not to make setup unusable.

### 5. Project documentation

Resolve [PROJECT_DOC_TEMPLATES](../shared/PROJECT_DOC_TEMPLATES.md) using the content procedure.
Create canonical `.mpx/CONTEXT.md` and `.mpx/DECISIONS.md`, replacing the project placeholder, but
never overwrite substantive content.

### 6. Framework rule

Follow `PLATFORM_REFERENCE.md` to link the central React rule into `.claude/rules/react.md`, verify
the link target, and retain the exact platform-correct manual command when linking fails.

### 7. Commit and push

```bash
git -C <project-path> add -A
git -C <project-path> commit -m "chore: initialize monorepo from template"
git -C <project-path> push -u origin dev
```

Do not create an empty commit. On push failure preserve local commits and report remediation.

## Report

Report URL, default branch, `main`/`dev` protection separately, push result, check results,
framework-rule state/manual command, exceptions, and this structure:

```text
apps/web       React + Vite Plus
apps/mobile    Expo + React Native + Expo Router
apps/api       Hono backend
packages/shared  types, hooks, clients, schemas
packages/ui      Gluestack UI + NativeWind
packages/config  shared ESLint and TypeScript config
```
