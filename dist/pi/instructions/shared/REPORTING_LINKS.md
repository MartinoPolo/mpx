# Links in user-facing reports

Use standard Markdown links with descriptive labels for important files, folders, generated
artifacts, PRs, issues, CI runs, and supporting web sources. Link created or updated deliverables in
progress and final reports; do not leave the user with only an identifier or an unlinked path.

## Local files and folders

- Prefer absolute `file:///` URIs so the terminal can offer its native editor and default-app
  actions. Resolve paths from the runtime's machine roots; use forward slashes and URI-encode spaces
  and reserved characters in path segments.
- Reserve `vscode://` links for an explicit request to open VS Code, not ordinary file references.
- Include useful line locations. Orca supports `#L42` and `#L42C7` fragments on file URIs; these
  fragments are not portable file-URI line semantics. When support is unknown, link the file and
  state the line or range beside it rather than changing the editor scheme.
- Keep labels recognizable, preferably the filename or artifact name. Avoid repeating the same
  destination unnecessarily, but make important deliverables easy to find and open.

## Provider and web links

Use canonical HTTPS URLs returned by the provider for created or updated PRs, issues, and CI runs.
Include the identifier in the label when useful. Do not construct a guessed URL or report an
unconfirmed creation as successful. Use ordinary HTTPS links for supporting web sources.

## Terminal rendering

Markdown syntax does not guarantee a clickable label: the renderer may emit an OSC 8 hyperlink or
show the label followed by the URL. Preserve visible destinations when native terminal link actions
are desired. In Orca, the visible file URL supports native file-opening choices even when the label
is only styled text. Do not force OSC 8 merely to hide the destination; retain automatic capability
detection unless the user requests a different rendering mode.

This policy applies to user-facing reports, not repository documentation links. Canonical content
continues to follow [Content Paths](CONTENT_PATHS.md).
