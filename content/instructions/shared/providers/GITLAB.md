# GitLab native reference

After the shared target check, use `TARGET=PROJECT` on the selected default host or `TARGET=HOST/PROJECT` on another host; `PROJECT` is the complete namespace path. For API calls percent-encode every `/` in `PROJECT` as `%2F` and add `--hostname HOST` when a non-default host was verified.

Issues:

- list/view: `glab issue list --repo <TARGET> --output json [--state opened|closed]`; `glab issue view <iid> --repo <TARGET> --output json`
- create: `glab api projects/<ENCODED_PROJECT>/issues [--hostname <HOST>] --method POST --raw-field title=<title> --raw-field description=<body>`
- edit/label/comment: the same API prefix, respectively `issues/<iid> --method PUT` with `title=`, `description=`, or `add_labels=`; and `issues/<iid>/notes --method POST --raw-field body=<body>`
- close: `glab issue close <iid> --repo <TARGET>` and then read it back

Merge requests:

- view: `glab mr view <iid> --repo <TARGET> --output json`
- create: `glab api projects/<ENCODED_PROJECT>/merge_requests ... --method POST --raw-field title=<title> --raw-field description=<body> --raw-field source_branch=<source> --raw-field target_branch=<target>`
- edit/comment: `merge_requests/<iid> --method PUT` with supported changed fields; `merge_requests/<iid>/notes --method POST --raw-field body=<body>`
- ready: `glab mr update <iid> --ready --yes --repo <TARGET>`
- merge, only after fresh authorization: `glab mr merge <iid> --yes --repo <TARGET>` plus exactly one approved `--squash` or `--rebase` when requested

CI uses an explicit pipeline/job ID: `glab api projects/<ENCODED_PROJECT>/pipelines/<pipeline-id>` and `.../pipelines/<pipeline-id>/jobs`; poll those boundedly to watch. Logs are `glab ci trace <job-id> --repo <TARGET>` and an authorized retry is `glab ci retry <job-id> --repo <TARGET>`. These are the supported operations; do not infer IDs or invent movement, repository administration, or label-creation support.
