# Repository initialization branch

Read this branch only when the project has no Git repository.

## Procedure

1. Check `git -C "<project>" rev-parse --git-dir`. If it succeeds, preserve the existing
   repository and return to the parent workflow.
2. If it fails, invoke the canonical `repository-setup` skill through the runtime's
   cross-skill contract and carry out that workflow in the resolved project directory.
   Do not substitute a provider CLI or a legacy skill checkout. Preserve its visibility
   confirmation gate and all repository, instruction, branch, and policy outcomes.
3. Preserve any pre-existing planning documents and project instructions. Replace only a
   generated minimal instruction seed when the canonical workflow explicitly identifies it
   as generated; derive refinements from the project's own documentation and never invent
   stack commands.
4. Before returning, verify that the repository exists and that real project instructions
   are committed. Record created or skipped initialization and any policy degradation in
   the closing report.
