---
argument-hint: "[project directory]"
description: Loads the mp-init-github-repo skill when explicitly referenced.
metadata:
  author: MartinoPolo
  category: setup
  version: "0.7"
name: mp-init-github-repo
---

# Initialize GitHub Repository

Initialize a new repository with deterministic local configuration, shared agent instructions,
GitHub publication, and branch protection. This skill continues the original `init-repo` workflow.
`dev` is the default development branch; `main` is for stable releases.

Invocation selects GitHub explicitly, not GitLab or another provider. Read
[Provider Routing](../../../../../pi/instructions/shared/PROVIDER_ROUTING.md) and the
[GitHub guide](../../../../../pi/instructions/shared/providers/GITHUB.md); use their repository-creation exception when no
project config exists yet. Preserve the active native GitHub authentication and environment.

## 1. Resolve and check the project

Resolve the explicit project directory. A bare name may be resolved beneath `MPX_PROJECTS`; ask when
ambiguous and stop if a required root is unset. Run all following commands from that project
directory.

If `git rev-parse --git-dir` succeeds, inform the user and stop without modifying the existing
repository, including a worktree or a directory inside another repository. If a project
configuration exists and selects a non-GitHub repository provider, stop rather than changing it.
Confirm `gh auth status --hostname github.com` succeeds; never log in or switch accounts
automatically. If `GH_HOST` selects a host other than `github.com`, stop rather than redirecting
repository creation or changing that environment.

## 2. Initialize local files

Inspect existing `.gitignore`, `.gitattributes`, `.editorconfig`, `AGENTS.md`, and `CLAUDE.md`
before running the script: these exact seed files, including preserved existing files, enter the
initial commit. Check them for private data and confirm any questionable content with the user
before proceeding. Links or non-file seed paths block initialization.

Resolve the bundled [initializer](scripts/init-repo.mjs) relative to this loaded skill. Store its validated literal absolute path as `<initializer>`, then run:

```bash
node "<initializer>"
```

It uses the bundled [gitignore template](templates/gitignore.template), creates `.gitattributes`,
`.editorconfig`, `AGENTS.md`, and `CLAUDE.md` when absent, preserves existing files, and commits
only those seed files. Stop on a script or commit failure; preserve the partial local setup and
report the error. Append project-specific ignore entries only when needed. `.mpx/` must remain
versioned, not ignored.

## 3. Create project documentation

Read [PROJECT_DOC_TEMPLATES](../../../../../pi/instructions/shared/PROJECT_DOC_TEMPLATES.md) as the single source for
`.mpx/CONTEXT.md` and `.mpx/DECISIONS.md`. Preserve substantive planning, research, decisions, and
prior grilling output. Create only missing files or untouched placeholders, reproducing the
canonical scaffold and replacing the project-name placeholder. Verify each file contains preserved
substantive content or the new scaffold. Then run:

```bash
git add .mpx/CONTEXT.md .mpx/DECISIONS.md
git commit -m "docs: initialize project documentation"
```

This separate commit is needed because the initializer commits before `.mpx/` exists. If neither
document changed, skip the empty commit and report that fact. Inspect the staged diff before each
commit; never stage unrelated files or secrets. Existing substantive documents must be checked for
private data before publication too.

## 4. Confirm GitHub target and visibility

Ask whether the repository should be **private** (recommended/default) or **public**. Resolve the
authenticated owner with `gh api --hostname github.com user --jq .login`, propose the current
directory name as the repository name, and confirm the exact `OWNER/REPO` target and visibility
before publication. Validate both as GitHub owner/repository names, not flags, paths, or shell
expressions. Keep this explicit target for every hosted command; do not use implicit
`{owner}`/`{repo}` substitution.

## 5. Create GitHub repository and push

Rename the current initial branch to `main` with `git branch -m main` only if it is not already
`main`. Create the confirmed target using exactly the selected visibility flag:

```bash
gh repo create "<owner>/<repo>" --private --source=. --remote=origin --push
```

Use `--public` instead of `--private` only when selected. On an uncertain creation result, reconcile
that exact GitHub target and local remote before retrying; never adopt an unrelated existing
repository or create a duplicate.

Verify `origin` is the confirmed GitHub target, then:

```bash
git checkout -b dev
git push -u origin dev
gh api --hostname github.com "repos/<owner>/<repo>" -X PATCH --field default_branch=dev
```

Stop and report any failed create, push, or default-branch update with the completed steps and exact
remaining work. Do not claim publication succeeded from local commits alone.

## 6. Protect main and dev

Run for each of `main` and `dev`, substituting the confirmed owner/repository and branch:

```bash
gh api --hostname github.com "repos/<owner>/<repo>/branches/<branch>/protection" -X PUT --input - <<'EOF'
{
  "required_status_checks": {"strict": false, "contexts": ["checks"]},
  "enforce_admins": true,
  "required_pull_request_reviews": {"required_approving_review_count": 0},
  "restrictions": null
}
EOF
```

If protection fails with HTTP 403, warn and continue with protection explicitly marked **not
applied**. When the response identifies a private-repository plan limitation, suggest upgrading to a
supporting plan or explicitly choosing public visibility later; never change visibility
automatically. Do not mislabel permission failures as plan limitations. Report other errors as
blockers. The required status check `checks` is a placeholder; the actual CI workflow is added
separately.

## 7. Verify and report

Read back the exact repository, both branches, default branch, and protection settings using
target-bound GitHub API reads. Verify local status and commits. Report:

- `.git/`, `.gitignore`, `.gitattributes`, `.editorconfig`, `AGENTS.md`, `CLAUDE.md`, and `.mpx/`
  created or preserved;
- commits actually created and remaining uncommitted files;
- GitHub URL and selected visibility;
- `main` and `dev` pushed, with `dev` as default, or the precise incomplete step;
- protection applied or skipped for each branch, with the reason;
- the pending real CI workflow replacing the `checks` placeholder.
