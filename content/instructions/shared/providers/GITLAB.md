# GitLab Native Guide (`glab`)

Applies only when the selected role is `gitlab`. Follow [Provider Routing](../PROVIDER_ROUTING.md), preserve native
authentication and any launch-injected `GLAB_CONFIG_DIR`, and bind CLI commands with `--repo <TARGET>`. Use
`TARGET=PROJECT` only when the independently selected host is the validated default; otherwise use `HOST/PROJECT`. For
API calls percent-encode every `/` in the complete project path as `%2F` and pass `--hostname <HOST>`.

Installed `glab 1.107.0 --help` verifies `--repo`, JSON issue output, API `--field key=@file`, pagination, milestone
JSON, and the CI commands below. Check subcommand help before optional version-sensitive flags.

## Issues and milestones

```text
glab issue list --repo <TARGET> --output json                         # open
glab issue list --repo <TARGET> --output json --closed                # closed
glab issue list --repo <TARGET> --output json --all                   # all
glab issue view <iid> --repo <TARGET> --output json
glab api projects/<ENCODED_PROJECT>/issues --hostname <HOST> --method POST \
    --raw-field title=<title> --field description=@<body-file> \
    [--raw-field labels=<csv>] [--raw-field milestone_id=<id>]
glab api projects/<ENCODED_PROJECT>/issues/<iid> --hostname <HOST> --method PUT \
    [--raw-field title=<title>] [--field description=@<body-file>] \
    [--raw-field add_labels=<csv>] [--raw-field remove_labels=<csv>] \
    [--raw-field milestone_id=<id>]
glab api projects/<ENCODED_PROJECT>/issues/<iid>/notes --hostname <HOST> --method POST --field body=@<body-file>
glab issue close|reopen <iid> --repo <TARGET>
glab label list --repo <TARGET> --output json
glab milestone list --repo <TARGET> --project <PROJECT> --state active|closed --output json --per-page 100
```

Resolve exact milestone IDs before assignment. Label or milestone creation is unsupported by this guide. Relationships
use reciprocal body links rather than Epic/sub-Issue semantics.

## Merge requests and CI

```text
glab mr view <iid> --repo <TARGET> --output json
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

Poll explicit pipeline/job IDs boundedly; never infer an update or retry target. Merge requires fresh human
authorization. Reliable cross-version watch semantics, client-selected non-exposed merge behavior, native hierarchy, and
automatic body-link synchronization are unsupported.
