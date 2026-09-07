# Provider Operations

Canonical skills invoke native provider tools directly. MPX does not expose Issue, Review, or CI facade commands; project configuration selects a reference, never an account or command.

## Resolve configuration and target

1. From the explicit repository/board working directory, walk toward the filesystem root and stop at the nearest `mpxconfig.json`. Do not skip an invalid nearer file. Read that file as JSON and stop if it is malformed or if its documented fields have invalid types. Require `schemaVersion: 1`, a non-empty `project.id`, and non-empty `repository.provider` and `repository.remote` strings; validate the selected role fields described below. This project-only check must not depend on user identity, routing, installation, or session diagnostics.
2. For Issue/board work select `issues.provider`; for Review, CI, and repository work select `repository.provider`. Reject an absent Issue configuration, unknown provider, or role mismatch. Map the ID only to the shipped reference below.
3. Only for forge-backed GitHub, GitLab, or Gerrit operations, derive the repository target. `repository.remote` is a Git remote **name**, not a forge project. In the repository run the read-only command `git remote get-url -- <repository.remote>`. Require exactly one non-empty result. Parse only:
   - `https://HOST/PROJECT[.git]` (no user-info, query, or fragment);
   - `ssh://[USER@]HOST[:PORT]/PROJECT[.git]`;
   - `[USER@]HOST:PROJECT[.git]` (scp form).
     Here `PROJECT` is the complete slash-separated path after the host. Remove one terminal `.git`; reject empty/dot/traversal segments, local/file paths, malformed ports, multiple meanings, and every other URL form. The result is the explicit `{host, project}` CLI target. Do not use `project.id` as forge identity.
4. Only for those forge-backed operations, if the caller supplied a repository target, compare its normalized host and complete project path with the remote-derived target. A host omitted by native syntax is allowed only when the tool's selected host is independently explicit and equal. On mismatch or ambiguity, stop and ask; otherwise use the remote-derived target without asking the caller to repeat it. Never silently prefer conflicting configuration, remote, or user input. Gerrit additionally retains the configured remote name for an authorized `git push`.
5. Non-forge providers do not use steps 3–4. For KanbanFlow, run `kf` from the repository root, read `kf board --json`, and require its single board `_id` to equal `issues.boardId` before any task operation; stop if either value is absent or differs. For `local`, follow its shipped reference. `generic` and `none` have no hosted operation.

Run native tools in their unchanged authentication environment. Never login/logout, switch accounts, derive credentials, or materialize identity routes.

## Shipped references

- `github`: [GitHub (`gh`)](providers/GITHUB.md)
- `gitlab`: [GitLab (`glab`)](providers/GITLAB.md)
- `kanbanflow`: [KanbanFlow (`kf`)](providers/KANBANFLOW.md)
- `gerrit`: [Gerrit (Git/SSH)](providers/GERRIT.md)
- `local`: [Local files](providers/LOCAL.md)
- `generic` and `none`: no hosted Issue, Review, or CI operation; provide a bounded manual handoff

Capture immutable Issue, Review, job, and run IDs and reuse them. Prefer the structured output named by the reference. Preserve native errors; do not improvise an unsupported capability.

## Authorization and labels

Reads may proceed after resolution. Before each mutation, show the explicit target and intended change and retain the calling skill's authorization gate. Never mutate beyond approved scope. Merge always requires fresh human authorization.

Use an existing semantic-label mapping or inspect existing provider labels. If a requested label is missing, ask whether to create it. Create it only when the calling skill requests that workflow and the user authorizes creation; otherwise ask whether to proceed without it. Never silently invent, create, or omit labels.
