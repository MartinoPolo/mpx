---
name: symlink
description: "Creates, verifies, and safely removes real Windows symbolic links from Git Bash."
metadata:
  mpx:
    skillPacks: [work]
    defaultExposure: name-only
---
# Windows Symlinks

Create links that survive Git and resolve consistently on Windows.

**The one rule:** create every link from Git Bash with `cmd //c mklink`. The doubled slash prevents MSYS from rewriting `/c`, and `cygpath -w` supplies the Windows paths required by `mklink`.

Git Bash `ln -s` may copy the target instead of creating a link when `core.symlinks=false`.

## Create

Files take no type flag. Directories take `//D`.

```bash
# file
cmd //c mklink "$(cygpath -w "$LINK")" "$(cygpath -w "$TARGET")"

# directory
cmd //c mklink //D "$(cygpath -w "$LINK")" "$(cygpath -w "$TARGET")"
```

Guard creation so reruns are idempotent. Match the command to the target type:

```bash
[ -e "$LINK" ] || cmd //c mklink "$(cygpath -w "$LINK")" "$(cygpath -w "$TARGET")"
[ -e "$LINK" ] || cmd //c mklink //D "$(cygpath -w "$LINK")" "$(cygpath -w "$TARGET")"
```

## One-time Git prerequisite

Git for Windows can rewrite checked-out symlinks as plain text when `core.symlinks=false`. Enable symlink checkout once per machine:

```bash
git config --global core.symlinks true
```

## Verify

```bash
ls -la "$(dirname "$LINK")"  # real links show name -> target
readlink -f "$LINK"          # resolves the target path
MPX_SYMLINK_PATH="$(cygpath -w "$LINK")" powershell.exe -NoProfile -Command 'Get-Item -LiteralPath $env:MPX_SYMLINK_PATH | Select-Object Name,LinkType,Target'
```

`LinkType = SymbolicLink` confirms a real link. A blank `LinkType`, or no `->` in `ls -la`, indicates a copy rather than a link.

## Remove only the link

```bash
rm "$LINK"
```

`rm` removes file and directory symlinks without removing the target. Keep the path free of a trailing slash, and do not use `rm -rf`, because either can reach through a directory link into its target.
