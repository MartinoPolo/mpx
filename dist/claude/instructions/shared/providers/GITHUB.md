# GitHub Native Guide (`gh`)

Applies when the independently selected repository or Issue role is `github`. Follow [Provider Routing](../PROVIDER_ROUTING.md),
preserve native authentication and any existing `GH_CONFIG_DIR`, and bind every command with
`--repo [HOST/]OWNER/REPO`.

Installed `gh 2.86.0 --help` verifies the forms below. Prefer `--body-file <file>` for reviewed
multiline content.

## Repository initialization

The explicitly invoked development `init-github-repo` skill owns repository creation, initial
pushes, default-branch selection, and protection setup. Its reviewed native commands are
`gh repo create OWNER/REPO --private|--public --source=. --remote=origin --push`, and
`gh api --hostname github.com` for `user`, `repos/OWNER/REPO`, and
`repos/OWNER/REPO/branches/BRANCH[/protection]`. Confirm owner/name and visibility before creating;
bind API paths to those literal validated values. Follow the repository-creation exception in
Provider Routing instead of requiring a remote that does not exist yet. Preserve the native
authentication environment.

## Issues

```text
gh issue list --repo <target> --state open|closed|all --limit 100 \
    --json number,id,title,body,state,labels,milestone,url,assignees
gh issue view <issue> --repo <target> --comments \
    --json number,id,title,body,state,labels,milestone,url,assignees,comments
gh issue create --repo <target> --title <title> --body-file <file> \
    [--label <label>] [--milestone <name>]
gh issue edit <issue> --repo <target> [--title <title>] [--body-file <file>] \
    [--add-label <label>] [--remove-label <label>] [--milestone <name>]
gh issue comment <issue> --repo <target> --body-file <file>
gh issue close|reopen <issue> --repo <target>
gh label list --repo <target> --limit 100
gh label create <name> --repo <target> --color <hex> --description <text>
gh api --hostname <host> repos/<owner>/<repo>/milestones --paginate --jq '.[] | {number,title,state,due_on}'
```

Resolve milestones by exact title before assignment; create one only with explicit authorization.
Use body links, not native sub-Issues.

## Pull requests and CI

```text
gh pr create --repo <target> --base <base> --head <branch> --title <title> --body-file <file> [--draft]
gh pr view <pr> --repo <target> --comments --json number,id,title,body,state,isDraft,mergeable,statusCheckRollup,url
gh pr edit <pr> --repo <target> [--title <title>] [--body-file <file>] \
    [--base <base>] [--add-label <label>] [--remove-label <label>]
gh pr comment <pr> --repo <target> --body-file <file>
gh pr ready <pr> --repo <target>
gh pr checks <pr> --repo <target> --json name,state,bucket,link [--watch]
gh run list --repo <target> --branch <branch> --limit 20 --json databaseId,name,headBranch,headSha,status,conclusion,url
gh run watch <run-id> --repo <target> --exit-status
gh run view <run-id> --repo <target> --log-failed
gh run rerun <run-id> --repo <target> --failed
gh pr merge <pr> --repo <target> --merge|--squash|--rebase
```

Merge only with fresh human authorization for the exact strategy. Arbitrary review-state
transitions, native hierarchy, and automatic body-link synchronization are unsupported.
