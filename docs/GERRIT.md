# Gerrit workflow (agentic)

How an agent uploads changes to a Gerrit-hosted repository. The workflow is
repository-neutral: confirm the repository's own contribution rules, branch name,
and access configuration before making changes.

Gerrit is **not** GitHub: reviews are created by pushing commits rather than by
opening pull requests. Each commit becomes a _change_ identified by a `Change-Id`
trailer, and is pushed to the magic ref `refs/for/<target-branch>`. A new patchset
for an existing review is another push of a commit carrying the **same**
`Change-Id`.

## MPX provider behavior

The fixed Gerrit provider implements `review.view`, `review.create`,
`review.update`, `review.comment`, `review.ready`, and `review.merge`. It does not
implement Issue or CI capabilities.

- The configured Git remote is parsed as an exact safe `HOST/PROJECT` selector;
  nested Gerrit project paths are supported. Uploads use that configured remote
  name, never an assumed `origin`.
- Reads use `ssh HOST gerrit query --format=JSON --current-patch-set --
project:PROJECT ...` and accept exactly one bounded JSON-lines result plus its
  stats record.
- Create validates source and target refs and requires the requested title/body
  to exactly match the selected local commit before pushing that exact commit to
  `refs/for/TARGET%ready` or `%wip`. Update similarly validates `HEAD`, queries
  the existing change's target branch, and uploads `HEAD` as a new patchset.
  MPX never commits, amends, checks out, or otherwise mutates local Git state.
- Comment uses `gerrit review --message`. Its result contains only the known
  mutation acknowledgement; author and server timestamp are omitted because the
  SSH command does not return them.
- Ready uses the documented structured `gerrit review --json` input to atomically
  set `ready: true` and apply `Code-Review +2` to the current patchset. This
  avoids a `%ready` re-push that Gerrit could reject as “no new changes.” A
  dispatch failure or ambiguous read-back is reported as
  `MUTATION_OUTCOME_UNKNOWN`; MPX never retries automatically.
- Merge invokes only `gerrit review --submit`. Gerrit's configured submit
  strategy remains authoritative, so client-selected merge, squash, or rebase
  methods are rejected.

All subprocesses are fixed `git`/`ssh` argv with bounded time and output and no
shell. In a launched runtime, direct SSH is forced through the exact
launch-owned `MPX_RUNTIME_ROUTE_SSH/config`; otherwise native SSH configuration
is used. Errors do not include route paths, command stderr, or response bodies.
The command contract is covered by automated tests. Live acceptance is tracked
separately because this repository does not provide a live Gerrit server.

## Access (Windows specifics)

A typical SSH remote has this form:

```text
ssh://<user>@<gerrit-host>:29418/<repository>.git
```

The SSH port is commonly `29418`, but use the port configured by the Gerrit
instance. Keep host, user, port, and identity settings in `~/.ssh/config` where
possible. Refer to a required key generically as `<ssh-key>`; do not hard-code
personal key paths in repository documentation.

The `commit-msg` hook is installed per clone at `.git/hooks/commit-msg`. Tools
such as `git-review` are optional unless the repository explicitly requires them.

### The Windows ssh-agent gotcha

Git for Windows can be configured to use Windows OpenSSH:

```bash
git config core.sshCommand C:/Windows/System32/OpenSSH/ssh.exe
```

If `<ssh-key>` is loaded in the **Windows** OpenSSH agent, Git operations can
work while Git Bash's bundled `ssh` reports `Permission denied (publickey)`
because it may use a different agent. Verify the path Git uses and test the
remote before treating this as an access failure:

```bash
git config --get core.sshCommand
git ls-remote origin HEAD
```

To run Gerrit's SSH CLI with the same Windows agent, call `ssh.exe` explicitly:

```bash
C:/Windows/System32/OpenSSH/ssh.exe -p 29418 <user>@<gerrit-host> gerrit version
```

The Gerrit SSH commands (`gerrit query`, `gerrit review`, `gerrit version`, and
others) are the command-line interface exposed by the server; there need not be
a separate local Gerrit binary.

## Preflight

1. Confirm required network access according to the Gerrit instance's public or
   organizational documentation. `git ls-remote origin HEAD` should return a
   hash.
2. Confirm that `.git/hooks/commit-msg` exists. If it is missing, retrieve it
   from the Gerrit server using the configured port:

   ```bash
   C:/Windows/System32/OpenSSH/scp.exe -P 29418 <user>@<gerrit-host>:hooks/commit-msg .git/hooks/commit-msg
   chmod +x .git/hooks/commit-msg
   ```

3. Confirm that `git config user.name` and `git config user.email` match the
   identity registered with Gerrit and any repository contribution rules.
4. Confirm `<target-branch>` from the remote and repository documentation; do
   not assume a default branch name.

## Upload a change

Work on a local topic branch based on the current target branch, then push the
commit to `refs/for/<target-branch>`:

```bash
git fetch origin
git switch -c <topic> origin/<target-branch>
# ...edit...
git commit -F <message-file>
git push origin HEAD:refs/for/<target-branch>%topic=<topic>
```

The `commit-msg` hook adds a `Change-Id` to a new commit. On a successful push,
Gerrit normally prints the change URL; capture it for reporting.

- **Amend, don't stack**, when revising one change:
  `git commit --amend -F <message-file>`. Preserve the existing `Change-Id`
  byte-for-byte, then push to the same `refs/for/<target-branch>` ref. Gerrit
  attaches the commit as a new patchset on the existing review.
- Push options follow `%`. Common options include `topic=<topic>`, `wip`,
  `ready`, `r=<reviewer>`, and `hashtag=<tag>`. Separate multiple options with
  commas, for example:
  `refs/for/<target-branch>%topic=<topic>,wip`.
- Confirm supported push options and permissions with the Gerrit instance; they
  can vary by version and configuration.

## Commit message rules

Follow the target repository's documented commit-message conventions. Gerrit's
load-bearing requirements are:

- Write a concise subject and a body that explains the reason for the change.
- **Never invent or regenerate `Change-Id:`**. Let the hook add it to a new
  commit, and preserve it verbatim when amending or rewording. Changing it
  creates a different review instead of a new patchset.
- Preserve existing review-related trailers when amending unless the repository
  or reviewer explicitly directs otherwise.
- Keep trailers in the final footer block, separated from the body by a blank
  line. Do not add unrelated automation, session, or attribution trailers unless
  repository policy requires them.
- Do not apply GitHub pull-request or trailer conventions automatically to a
  Gerrit repository.

## Safety

- Read and follow the repository's contribution instructions before editing.
- Stage explicit paths only; never use `git add -A` or `git add .`.
- Inspect `git diff --cached` before committing.
- Never force-push, use `reset --hard`, or rewrite published history.
- Keep one logical change per commit and per review.
- Do not upload credentials, personal identities, internal host details, or
  machine-specific paths in commits or documentation.
