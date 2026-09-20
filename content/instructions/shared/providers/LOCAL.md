# Local provider: unsupported

The native-first MPX contract does not implement or import a local Issue provider. If
`issues.provider` is `local`, stop the affected Issue branch and report that the provider is
unsupported. Do not reinterpret the value as GitHub, infer a provider from remotes, import a legacy
Markdown store, or route through old MPX application services.

Repository operations still use their independently configured GitHub, GitLab, or Gerrit provider.
Changing the Issue provider requires an explicit user configuration change.
