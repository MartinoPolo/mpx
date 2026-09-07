# Native provider operations

MPX no longer exposes a provider facade or adapter registry. Canonical skills resolve the nearest `mpxconfig.json`, validate it without skipping an invalid nearer manifest, and select `issues.provider` for Issue operations or `repository.provider` for Review, CI, and repository operations.

The selected provider ID maps directly to the shipped native-command references in `content/instructions/shared/providers/`: GitHub (`gh`), GitLab (`glab`), KanbanFlow (`kf`), Gerrit (Git/SSH), and local Markdown files. Project configuration cannot define commands, executables, credentials, accounts, identities, or reference names. Native authentication environments remain unchanged.

Every operation requires an explicit repository, board, project, Issue, Review, or run target as documented by the selected reference. Unknown providers, invalid manifests, ambiguous targets, missing native tools, and unsupported capabilities stop with a bounded manual handoff. Mutations retain their skill authorization gates, and merge always requires fresh human authorization.

Local Markdown issue storage and Obsidian issue-view rebuilding remain available as a narrow application-owned data component; they are not a general provider facade. See [Local Markdown issues](local-markdown-issues.md).
