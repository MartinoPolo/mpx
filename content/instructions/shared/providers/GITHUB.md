# GitHub native reference

Use `gh` without login/logout/account-switch commands and bind every command with `--repo OWNER/REPO` (or `HOST/OWNER/REPO`). Read issues with `gh issue list --repo <target> --json number,id,title,body,state,labels,url,assignees` and `gh issue view <id> --repo <target> --json number,id,title,body,state,labels,url,assignees`. Create/edit/comment/label/close with the corresponding `gh issue create|edit|comment|close`, always `--repo <target>`.

Use `gh pr view|create|edit|comment|ready|merge` with `--repo <target>` for reviews. Create requires explicit `--head` and `--base`. Inspect/watch CI with `gh pr checks <review-id> --repo <target> --json name,state,bucket,link [--watch]`; failed logs use `gh run view <run-id> --repo <target> --log-failed`, and an authorized retry uses `gh run rerun <run-id> --repo <target> --failed`.

Never merge without fresh human authorization.
