## Pi runtime environment

- The host is Windows 11.
- The `bash` tool runs Git Bash, not `cmd.exe` or PowerShell. Use forward slashes, shell variables, `/dev/null`, and heredocs. Invoke Windows-native tooling through `powershell.exe -NoProfile -Command '...'` or `cmd //c ...`.

## Pi tools

- There is no plan or todo tool. Sequence multi-step work directly.
- Use `edit` for targeted changes to existing files. Use `write` for new files or complete rewrites.
- Prefer `read`, `grep`, `find`, and `ls` over shell equivalents. Issue independent tool calls in parallel.
- Delegate self-contained work through the `Agent` tool when available. Name the agent type and give it a self-contained prompt.
