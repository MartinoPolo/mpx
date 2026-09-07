# Gerrit native reference

The shared remote parser must yield `HOST/PROJECT` (including any SSH user/port already present in the remote) and retain the safe configured remote name. Require a positive decimal change number. Do not invent SSH flags or alter Git/SSH authentication.

Supported syntax:

- read: `ssh [-p <remote-port>] [<remote-user>@]<host> gerrit query --format=JSON --current-patch-set -- limit:2 project:<project> change:<change-number>`; add `--comments` before `--` when comments are required. Require one result plus the stats record and verify its `project` equals the resolved project.
- create/update patch set: first read commit metadata with `git show -s --format=%H%x00%s%x00%b%x00 <source>^{commit} --`; require exactly one valid `Change-Id` trailer and exact requested title/body. After authorization push `git push <configured-remote-name> <commit-sha>:refs/for/<target>[%wip|%ready]`. Read back by both Change-Id/commit as applicable and reject mismatches.
- comment: query the current patch set, then `ssh ... gerrit review --message <safely-quoted-body> --project <project> -- <change-number>,<patch-set>` and read back.
- ready/vote: `ssh ... gerrit review --json --project <project> -- <change-number>,<patch-set>` with one JSON stdin line, respectively `{"ready":true}` or `{"labels":{"Code-Review":<-2..2>}}`.
- submit, only after fresh human authorization: `ssh ... gerrit review --submit --project <project> -- <change-number>,<patch-set>`; Gerrit chooses the server submit strategy.

Issue, board, CI, repository administration, client-selected merge methods, and unverified arbitrary labels are unsupported; provide a manual handoff.
