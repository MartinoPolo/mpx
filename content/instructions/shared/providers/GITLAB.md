# GitLab Native Guide (`glab`)

Applies only when `repository.provider` is `gitlab`. Issue-provider use is unsupported. Follow [Provider Routing](../PROVIDER_ROUTING.md),
preserve native authentication and any existing `GLAB_CONFIG_DIR`, and bind CLI commands with
`--repo <TARGET>`. Use `TARGET=PROJECT` only when the independently selected host is the validated
default; otherwise use `HOST/PROJECT`. For API calls percent-encode every `/` in the complete
project path as `%2F` and pass `--hostname <HOST>`.

Installed `glab 1.107.0 --help` verifies `--repo`, JSON issue output, API `--field key=@file`,
pagination, milestone JSON, and the CI commands below. Check subcommand help before optional
version-sensitive flags.

## Issue-provider boundary

GitLab Issue operations are outside the MPX Issue-provider contract. Do not execute them or
substitute GitLab for the independently selected GitHub or KanbanFlow Issue provider.

## Merge requests and CI

```text
glab mr view <iid> --repo <TARGET> --output json
glab api projects/<ENCODED_PROJECT>/merge_requests --hostname <HOST> --method GET \
    --raw-field source_branch=<source> --raw-field state=all --paginate
glab api projects/<ENCODED_PROJECT>/merge_requests --hostname <HOST> --method POST \
    --raw-field title=<title> --field description=@<body-file> \
    --raw-field source_branch=<source> --raw-field target_branch=<target>
glab api projects/<ENCODED_PROJECT>/merge_requests/<iid> --hostname <HOST> --method PUT \
    [--raw-field title=<title>] [--field description=@<body-file>] \
    [--raw-field target_branch=<target>]
glab api projects/<ENCODED_PROJECT>/merge_requests/<iid>/notes --hostname <HOST> --method POST --field body=@<body-file>
glab mr update <iid> --ready --yes --repo <TARGET>
glab api projects/<ENCODED_PROJECT>/pipelines --hostname <HOST> --paginate --output json
glab api projects/<ENCODED_PROJECT>/pipelines/<pipeline-id> --hostname <HOST>
glab api projects/<ENCODED_PROJECT>/pipelines/<pipeline-id>/jobs --hostname <HOST> --paginate --output json
glab ci trace <job-id> --repo <TARGET>
glab ci retry <job-id> --repo <TARGET>
glab mr merge <iid> --yes --repo <TARGET> [--squash|--rebase]
```

For draft creation through the API, prefix the title with GitLab's required `Draft: ` marker and
verify the returned draft state. The authored title after that provider marker retains the verified
Issue identifier. Removing the marker is a readiness transition and needs workflow authorization.

Poll explicit pipeline/job IDs boundedly; never infer an update or retry target. Merge requires
explicit authorization for the current run and permitted strategy. An invoked workflow that
explicitly authorizes merge supplies that authorization; otherwise ask the user. Reliable cross-version watch semantics, client-selected non-exposed merge
behavior, native hierarchy, and automatic body-link synchronization are unsupported.
