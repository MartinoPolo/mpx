# GitHub Native Guide (`gh`)

Applies when the independently selected repository or Issue role is `github`. Follow [Provider Routing](../PROVIDER_ROUTING.md),
preserve native authentication and any existing `GH_CONFIG_DIR`, and bind every command with
`--repo [HOST/]OWNER/REPO`.

Prefer `--body-file <file>` for reviewed multiline content.

## Issues

```text
gh issue list --repo <target> --state open|closed|all --limit 100 \
    --json number,id,title,body,state,labels,milestone,url,assignees
gh issue view <issue> --repo <target> --comments \
    --json number,id,title,body,state,labels,milestone,url,assignees,comments
gh issue create --repo <target> --title <title> --body-file <file> \
    [--label <label>] [--milestone <name>] [--assignee @me] [--attach <file>[#alt]]...
gh issue edit <issue> --repo <target> [--title <title>] [--body-file <file>] \
    [--add-label <label>] [--remove-label <label>] [--milestone <name>] [--attach <file>[#alt]]...
gh issue comment <issue> --repo <target> --body-file <file> [--attach <file>[#alt]]...
gh issue close|reopen <issue> --repo <target>
gh label list --repo <target> --limit 100
gh label create <name> --repo <target> --color <hex> --description <text>
gh api --hostname <host> repos/<owner>/<repo>/milestones --paginate --jq '.[] | {number,title,state,due_on}'
```

Resolve milestones by exact title before assignment; create one only with explicit authorization.
Use body links, not native sub-Issues.

## Pull requests and CI

```text
gh pr list --repo <target> --head <branch> --state all --limit 100 --json number,id,url,state,isDraft,baseRefName,headRefName,headRefOid,headRepositoryOwner
gh pr create --repo <target> --base <base> --head <branch> --title <title> --body-file <file> [--draft] [--attach <file>[#alt]]...
gh pr view <pr> --repo <target> --comments --json number,id,title,body,state,isDraft,mergeable,statusCheckRollup,url,baseRefName,headRefName,headRefOid,headRepositoryOwner
gh pr edit <pr> --repo <target> [--title <title>] [--body-file <file>] \
    [--base <base>] [--add-label <label>] [--remove-label <label>] [--attach <file>[#alt]]...
gh pr comment <pr> --repo <target> --body-file <file> [--attach <file>[#alt]]...
gh pr ready <pr> --repo <target>
gh pr checks <pr> --repo <target> --json name,state,bucket,link [--watch]
gh run list --repo <target> --branch <branch> --limit 20 --json databaseId,name,headBranch,headSha,status,conclusion,url
gh run watch <run-id> --repo <target> --exit-status
gh run view <run-id> --repo <target> --log-failed
gh run rerun <run-id> --repo <target> --failed
gh pr merge <pr> --repo <target> --merge|--squash|--rebase
```

Merge only with explicit authorization for the current run and permitted strategy. An invoked
workflow that explicitly authorizes merge supplies that authorization; otherwise ask the user. Arbitrary review-state
transitions, native hierarchy, and automatic body-link synchronization are unsupported.

## Images

`--attach` (gh 2.99+, images or video, up to 50 per command) uploads files. Reference each image
where it supports the text as `![alt](./shot.png)`, passing the same path to `--attach`; gh rewrites
the reference to the uploaded URL and appends unreferenced files. Body-file paths resolve from that
file's directory. A partial upload failure still creates or updates the item but exits non-zero, so
check the output. Uploaded `github.com/user-attachments/assets/` URLs are readable by anyone holding
them, even for private repositories: never attach secrets, personal data, or sensitive screenshots.
`gh issue view` returns only image URLs; to see one, download it with `curl -sL -o <file> <url>`
into `MPX_TEMP` and open the file.
