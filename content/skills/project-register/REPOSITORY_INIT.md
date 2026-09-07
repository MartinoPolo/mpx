# GitHub repository initialization branch

Read this branch only when the project has no Git repository.

## Procedure

1. Check `git -C "<project>" rev-parse --git-dir`. If it succeeds, preserve the repository and return to the parent
   workflow.
2. Resolve [`init-github-repo`](../init-github-repo/SKILL.md) relative to compiled content first, then through
   [Content Paths](../shared/CONTENT_PATHS.md). Stop on no match or ambiguity; never guess an old skills checkout.
3. Read and carry out that GitHub-specific workflow in the resolved project directory. Preserve its confirmation gates
   for owner/repository and private/public visibility, substantive files, and GitHub account. If the project is intended
   for another provider, stop this branch and ask for its initialization workflow rather than publishing to GitHub.
4. Verify the local repository, project instructions, documentation and commits, GitHub URL, `main`/`dev` branches,
   `dev` default branch, and per-branch protection results. Report incomplete steps or protection limitations accurately,
   then return to the parent workflow.
