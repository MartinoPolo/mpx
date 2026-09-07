# Issue, Review, and CI commands

MPX exposes one provider-neutral command surface. Provider selection comes from the nearest valid `mpxconfig.json`:
`issues.provider` controls `mpx issue`, while `repository.provider` controls `mpx review` and `mpx ci`. Every command
below requires an explicit `--identity NAME`, a strict user config at `%APPDATA%/mpx/config.json`, and an identity-owned
`providerRoutes` entry for the selected provider. `--cwd DIR` and `--json` are accepted globally and may appear anywhere
in the command.

## Normalized records

Provider adapters return version 1 normalized records rather than raw `gh`, `glab`, or `kf` output:

- `IssueV1`: `schemaVersion`, `id`, `title`, `body`, normalized `state` (`open` or `finished`), `labels`, and optional
  `url` and `assignees`.
- `IssueCommentV1`: `schemaVersion`, `id`, `issueId`, `body`, `author`, and `createdAt`.
- `ReviewV1`: `schemaVersion`, `id`, `title`, normalized `state` (`draft`, `open`, `merged`, or `closed`),
  `sourceBranch`, `targetBranch`, and optional `url`.
- `CiStatusV1`: `schemaVersion`, normalized aggregate `state`, and `checks`; each check has `id`, `name`, normalized
  `state` (`pending`, `running`, `passed`, `failed`, or `cancelled`), and optional `url`.

Provider-specific fields may appear only under `providerData.<provider>`. This namespace also applies to individual CI
checks. Consumers should rely on normalized top-level fields and treat namespaced data as optional provider detail.

## Issue

```text
mpx issue list --identity NAME [--state open|finished]
mpx issue view --identity NAME --id ID
mpx issue create --identity NAME --title TITLE --body BODY
mpx issue edit --identity NAME --id ID --title TITLE --body BODY
mpx issue comment --identity NAME --id ID --body BODY
mpx issue label --identity NAME --id ID --label LABEL
mpx issue move --identity NAME --id ID --destination DESTINATION
mpx issue finish --identity NAME --id ID
```

There are no positional Issue arguments: IDs and values must use the shown flags. `issue list --state open|finished`
filters by the normalized state; any other state is a usage error. Hosted-provider adapters translate that normalized
value to their native open/closed spelling, while KanbanFlow filters normalized tasks using its configured
state-to-column mapping. Hosted-provider IDs are canonical positive decimals; URLs, repository-qualified shortcuts,
flag-like values, and paths are rejected before provider execution. `issue.move` is currently available only with
KanbanFlow; its destination is a configured workflow state name (`todo`, `wip`, `review`, `done`, or optional
`archive`), not a raw column ID. GitHub and GitLab return `CAPABILITY_UNSUPPORTED` before adapter execution.

## Review

```text
mpx review view --identity NAME --id ID
mpx review create --identity NAME --title TITLE --body BODY --source-branch BRANCH --target-branch BRANCH
mpx review update --identity NAME --id ID --title TITLE --body BODY
mpx review comment --identity NAME --id ID --body BODY
mpx review ready --identity NAME --id ID
mpx review merge --identity NAME --id ID [--method merge|squash|rebase]
```

`review.create` derives draft behavior from `workflow.codeReview.openAsDraft` (default `false`); there is no public
draft flag. The committed workflow is a ceiling: when `markReady` is `human`, `review ready` returns
`WORKFLOW_POLICY_DENIED`; when `merge` is `human`, `review merge` does the same. `agent` permits the command but does
not bypass provider authorization or review rules. When `--method` is omitted, the provider chooses its default; Gerrit
always uses its server-configured submit strategy and rejects an explicitly selected method.

## CI

```text
mpx ci status --identity NAME --id REVIEW_OR_PIPELINE_ID
mpx ci watch --identity NAME --id REVIEW_OR_PIPELINE_ID
mpx ci logs --identity NAME --run-id RUN_ID
mpx ci retry --identity NAME --run-id RUN_ID
```

## Noninteractive use and errors

Use `--cwd DIR --identity NAME --json` for deterministic noninteractive invocation. Required values are always explicit;
commands do not prompt for identity, routes, IDs, text, branches, or merge method. Example:

```bash
mpx --cwd . --json issue view --identity personal --id 42
mpx --cwd . --json review create \
    --identity work \
    --title "Fix" \
    --body "Details" \
    --source-branch fix/42 \
    --target-branch main
mpx --cwd . --json ci status --identity work --id 17
```

JSON failures use `{apiVersion:1, ok:false, error, warnings:[]}`. `error` always contains `code`, `message`, and
`retryable`; it may contain `capability`, `remediation`, and safe `details`. Important fail-closed codes include
`IDENTITY_REQUIRED`, `IDENTITY_UNKNOWN`, `PROVIDER_ROUTE_REQUIRED`, `CAPABILITY_UNSUPPORTED`, `WORKFLOW_POLICY_DENIED`,
`EXECUTABLE_MISSING`, `AUTH_FAILURE`, `COMMAND_FAILURE`, `INVALID_RESPONSE`, and `MUTATION_OUTCOME_UNKNOWN`.
`MUTATION_OUTCOME_UNKNOWN` is always non-retryable. It means a mutating provider command may have succeeded even though
process failure made its outcome ambiguous, or (for GitHub create/comment) the mutation was confirmed but MPX could not
read the normalized result back. Repeating it could create a duplicate; callers must reconcile provider state rather
than retry automatically. A usage error exits 2; other command errors exit 1. MPX does not silently invoke provider CLIs
outside the trusted adapter.

See [Provider contracts](PROVIDERS.md) for the capability matrix and route model, and [Configuration](CONFIG.md) for
exact project and identity shapes.
