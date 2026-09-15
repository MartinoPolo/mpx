---
name: sync-base
description: 'Merges the target base branch into the current branch, resolving conflicts and pushing the result.'
metadata:
  author: MartinoPolo
  version: '1.4'
  category: git-workflow
  mpx:
    schemaVersion: 1
    skillPacks: [development]
    defaultExposure: name-only
---

# Sync Base Branch

Merge a target branch into the current branch. the invocation input

**Args:** `[branch]`

Resolve [`scripts/detect-base-branch.js`](scripts/detect-base-branch.js) relative to this loaded
skill first. If projection relocation makes that impossible, read `MPX_ACTIVE_CONTENT_ROOT`, require
an absolute path, resolve `skills/sync-base/scripts/detect-base-branch.js` beneath it, and verify
that the literal result exists and remains contained by that root. Stop if validation fails; do not
search ordered roots or guess an installation checkout. Store the validated literal path as
`BASE_BRANCH_DETECTOR`.

## Workflow

### Step 1: Determine Target Branch

If `the invocation input` provides a branch → use it.

Determine the current branch and its configured remote, then validate both before constructing refs:

```bash
git branch --show-current
git config --get branch.<current>.remote
git check-ref-format --branch <current>
git remote get-url <remote>
```

Use the configured remote; if none exists, ask which existing remote to use. Validate an explicit
target with `git check-ref-format --branch <target>`. Otherwise, run
`node "$BASE_BRANCH_DETECTOR" "" "<remote>"`. The detector chooses the existing candidate with the
**fewest commits HEAD is ahead of its merge-base**, with priority `dev > develop > main > master`
only breaking ties; it falls back to `main`. Display the target and remote.

### Step 2: Pre-merge Checks

**2a. Uncommitted changes:**

```bash
git status --porcelain
```

If non-empty → ask user: "Uncommitted changes detected. Stash before merging?"

- "Stash and continue" → create and record this operation's exact stash object:
  ```bash
  git stash push -u -m "Auto-stash before sync-base"
  git rev-parse --verify refs/stash
  ```
  Store the returned object ID as `<own-stash>`.
- "Abort"

Never use `git stash pop`: it can restore an unrelated stash if the stack changes.

**2b. Remote sync (current branch):**

```bash
git branch --show-current
git rev-parse --verify refs/remotes/<remote>/<current> 2>/dev/null
```

If no tracking branch → skip to Step 3.

Otherwise:

```bash
git fetch <remote> <current>
git rev-list --left-right --count HEAD...refs/remotes/<remote>/<current>
```

- **Behind only** → ask user: "Current branch is N behind remote. Pull first?"
  - "Pull remote changes (Recommended)" → `git pull <remote> <current>`
  - "Continue anyway"
- **Ahead only** → inform user, continue
- **Diverged** → ask user: "Branch diverged (N ahead, M behind). Pull first?"
  - "Pull (Recommended)" → `git pull <remote> <current>`
  - "Continue anyway"
- **In sync** → continue

### Step 3: Fetch and Preview

```bash
git fetch <remote> <target>
git rev-parse --verify refs/remotes/<remote>/<target>
git log HEAD..refs/remotes/<remote>/<target> --oneline
```

Display incoming commits. If none, restore this operation's stash (if any), then report "Already
up-to-date" and stop:

```bash
git stash apply <own-stash>
git stash drop <own-stash>
```

Drop only after successful apply; on conflicts, retain it and report the exact object ID.

### Step 4: Merge

```bash
git merge refs/remotes/<remote>/<target>
```

### Step 5: Resolve Conflicts (if any)

If conflicts occur:

1. List conflicted files: `git diff --name-only --diff-filter=U`
2. For each conflicted file: a. Read the file (use Read tool) b. Analyze conflict markers
   (`<<<<<<<`, `=======`, `>>>>>>>`) c. **Simple conflicts** (non-overlapping, clear intent) →
   resolve with Edit tool, then `git add <file>` d. **Complex conflicts** (overlapping logic,
   ambiguous) → show both sides to user, ask how to resolve
3. After all resolved: `git commit` (accept default merge message)
4. If new conflicts appear → repeat from step 1

### Step 6: Restore and Push

After a successful merge, restore this operation's stash (if any) by exact object ID:

```bash
git stash apply <own-stash>
git stash drop <own-stash>
```

Drop only after successful apply. Never pop or apply a stash selected by stack position.

If `refs/remotes/<remote>/<current>` exists (determined in Step 2b) → `git push <remote> <current>`.

If no remote tracking branch → skip push and inform the user.

## Output

After completion, display:

- Target branch merged
- Number of incoming commits applied
- Conflicts resolved (if any), with brief description
- **Session Activity:** list agents dispatched (if any)
