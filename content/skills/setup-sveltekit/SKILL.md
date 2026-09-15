---
name: setup-sveltekit
description: Create a SvelteKit repository from the authorized template with CI policy
triggers: setting up a SvelteKit repository
metadata:
  author: MartinoPolo
  version: '0.6'
  category: setup
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: explicit-only
---

# SvelteKit Project Setup

Read [provider routing](../shared/PROVIDER_ROUTING.md). Resolve linked files relative to this loaded
skill. For absolute reads, follow [Content Paths](../shared/CONTENT_PATHS.md). Because the
destination and its `mpxconfig.json` do not exist yet, take the **repository provider as explicit
setup input** (GitHub is the deliberate template source, not an automatic fallback), load its native
provider guide, and preserve the immutable launch identity. Never invent an MPX facade command or
derive the provider from another project's configuration.

## Flow

1. Get the project name and repository provider from invocation input or ask. Ask visibility
   (`private` recommended). Resolve the destination from an explicit path or an available
   `MPX_PROJECTS`/`MPX_WORK`; fail naming an unavailable required root instead of guessing.
2. For GitHub, use the documented native template behavior:
   ```bash
   gh api user --jq '.login'
   gh repo create <project-name> --template <user>/template-sveltekit --public|--private --clone
   ```
   First discover it with documented native metadata (for GitHub,
   `gh repo view <user>/template-sveltekit --json nameWithOwner,isTemplate,url`). If it is absent or
   is not marked as a template, tell the user to create or configure it and stop. For another
   selected provider, use an equivalent only if its native guide documents template creation;
   otherwise provide a manual handoff and stop.
3. Create and publish the development branch, then select it as default:
   ```bash
   git -C <path> checkout -b dev
   git -C <path> push -u origin dev
   gh repo edit <owner>/<project-name> --default-branch dev
   ```
4. On GitHub, apply protection to both `main` and `dev`:
   ```bash
   gh api repos/<owner>/<repo>/branches/<branch>/protection -X PUT --input - <<'EOF'
   {
     "required_status_checks": {"strict": false, "contexts": ["checks"]},
     "enforce_admins": true,
     "required_pull_request_reviews": {"required_approving_review_count": 0},
     "restrictions": null
   }
   EOF
   ```
   Repeat per branch. Preserve complete native errors and mark failed branches unprotected;
   protection failure does not abort remaining safe setup.
5. Install and verify:
   ```bash
   pnpm -C <path> install
   pnpm -C <path> run check:all
   pnpm -C <path> run test
   ```
   Preserve each failed command and complete output. Continue only after every failure is recorded
   and confirmed not to prevent setup.
6. Ask: **Do you want to add Svelte MCP support?** Only with consent run:
   ```bash
   npx -C <path> sv add mcp
   ```
7. Resolve [PROJECT_DOC_TEMPLATES](../shared/PROJECT_DOC_TEMPLATES.md) through the content
   procedure. Create its exact `.mpx/CONTEXT.md` and `.mpx/DECISIONS.md` scaffolds with the project
   placeholder replaced; preserve substantive files.
8. Verify the portable user-level Svelte rule at the runtime's configured rules location. If the
   runtime uses `~/.claude/rules`, run:
   ```bash
   ls -la ~/.claude/rules/svelte.md
   ```
   If missing, provide a platform-correct handoff to restore the configured rules projection; do not
   guess an old checkout or copy a mutable central rule.
9. Commit and push only actual authorized changes:
   ```bash
   git -C <path> add -A
   git -C <path> commit -m "chore: initial project setup"
   git -C <path> push
   ```
   Preserve local commits and report remediation if push fails.

## Report

```markdown
Repo: <provider URL> Default branch: dev Branch protection: main=<applied|failed reason>,
dev=<applied|failed reason> Template checks: <passing|failing details> Svelte MCP: <added|skipped>
Svelte rules: <found|missing and handoff> Push: <result> Exceptions: <none|details>
```
