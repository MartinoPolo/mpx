# Gerrit Native Guide (Git/SSH)

Applies only when `repository.provider` is `gerrit`. Follow
[Provider Routing](../PROVIDER_ROUTING.md). Do not require a nonexistent shared parser executable:
inspect the configured remote directly with `git remote get-url -- <repository.remote>` and parse
the single result according to the routing contract.

For `ssh://[USER@]HOST[:PORT]/PROJECT.git`, retain user, host, optional port, complete project path,
and configured remote name. For `[USER@]HOST:PROJECT.git`, retain user/host/project with no invented
port. HTTPS may identify host/project for reads, but it supplies no SSH user/port; use SSH only when
the existing environment/config independently resolves them without changing authentication. Reject
ambiguous, local, malformed, or mismatched targets. Require positive decimal change and patch-set
numbers.

## Supported operations

- Read:

  ```bash
  ssh [-p <port>] [<user>@]<host> gerrit query --format=JSON --current-patch-set \
    [--comments] -- limit:2 project:<project> change:<change-number>
  ```

  Require one change plus the stats record; verify returned project and change number.

- Create/update patch set: inspect metadata with
  `git show -s --format=%H%x00%s%x00%b%x00 <source>^{commit} --`; require exactly one valid
  `Change-Id` trailer and the requested title/body. After authorization, push the exact SHA with
  `git push <configured-remote-name> <commit-sha>:refs/for/<target>[%wip|%ready]`, then read back
  and verify Change-Id/commit.
- Comment: query the current patch set, then run
  `ssh ... gerrit review --message <safely-quoted-body> --project <project> -- <change-number>,<patch-set>`
  and read back.
- Ready/vote: send one JSON stdin line to
  `ssh ... gerrit review --json --project <project> -- <change-number>,<patch-set>`:
  `{"ready":true}` or `{"labels":{"Code-Review":<-2..2>}}`.
- Submit: only after fresh human authorization, run
  `ssh ... gerrit review --submit --project <project> -- <change-number>,<patch-set>`. Gerrit
  chooses the server submit strategy.

Never invent SSH flags, alter Git/SSH authentication, or push to an unvalidated remote/ref.
Issue/board operations, CI, repository administration, client-selected merge methods, and arbitrary
unverified labels are unsupported; provide a bounded manual handoff.
