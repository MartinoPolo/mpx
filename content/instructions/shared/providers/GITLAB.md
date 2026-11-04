# GitLab Native Guide (`glab`)

Applies when the independently selected repository or Issue role is `gitlab`. Follow [Provider Routing](../PROVIDER_ROUTING.md),
preserve native authentication and any existing `GLAB_CONFIG_DIR`, and bind CLI commands with
`--repo <TARGET>`. Use `TARGET=PROJECT` only when the independently selected host is the validated
default; otherwise use `HOST/PROJECT`. For API calls percent-encode every `/` in the complete
project path as `%2F` and pass `--hostname <HOST>`.

Installed `glab 1.107.0 --help` verifies `--repo`, JSON issue output, API `--field key=@file`,
pagination, milestone JSON, and the CI commands below. Check subcommand help before optional
version-sensitive flags.

## Issues

The Issue target is the repository's validated project when `repository.provider` is also
`gitlab`; otherwise `issues.metadata.project` supplies `HOST/PROJECT`. Write multiline bodies
through the API with `--field <key>=@<file>`; the `glab issue` forms accept only inline text.

```text
glab issue list --repo <TARGET> [--all | --closed] [--assignee @me] [--label <label>] \
    --per-page 100 --output json
glab issue view <iid> --repo <TARGET> --output json
glab api projects/<ENCODED_PROJECT>/issues/<iid>/notes --hostname <HOST> --paginate
glab api projects/<ENCODED_PROJECT>/issues --hostname <HOST> --method POST \
    --raw-field title=<title> --field description=@<body-file> \
    [--raw-field labels=<label,label>] [--raw-field milestone_id=<id>] [--raw-field assignee_ids=<user-id>]
glab api projects/<ENCODED_PROJECT>/issues/<iid> --hostname <HOST> --method PUT \
    [--raw-field title=<title>] [--field description=@<body-file>] [--raw-field add_labels=<label>] \
    [--raw-field remove_labels=<label>] [--raw-field milestone_id=<id>] [--raw-field assignee_ids=<user-id>]
glab api projects/<ENCODED_PROJECT>/issues/<iid>/notes --hostname <HOST> --method POST --field body=@<body-file>
glab issue close|reopen <iid> --repo <TARGET>
glab api user --hostname <HOST>
glab api projects/<ENCODED_PROJECT>/labels --hostname <HOST> --paginate
glab api projects/<ENCODED_PROJECT>/labels --hostname <HOST> --method POST \
    --raw-field name=<name> --raw-field color=<#hex> --raw-field description=<text>
glab api projects/<ENCODED_PROJECT>/milestones --hostname <HOST> --paginate
glab api projects/<ENCODED_PROJECT>/uploads --hostname <HOST> --method POST --form file=@<path>
```

`glab api user` returns your own user id for `assignee_ids`. Resolve milestones by exact title
before assignment; create one only with explicit authorization. An upload returns a `markdown`
field: place it in the body or note where the image supports the text. Uploads on a private
project need project access to view. Use body links, not native child items or epics.

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
