# Local Markdown issue v2 migration (one time)

MPX does not read legacy numeric (`<id>.md`) local issue files.

Before selecting a v2 logical store, run an explicit, offline migration that:

1. takes an exclusive backup of the legacy root;
2. validates every v1 document and all references;
3. allocates each destination name as `<zero-padded-id>-<slug>.md` without changing IDs;
4. writes the complete schema-version-2 frontmatter and `.mpx-index.json` into a new root;
5. validates missing references, cycles, checksums, and file counts;
6. atomically changes the identity-local logical store registration to the new root after human confirmation.

Rollback restores only the previous logical registration. The old root remains untouched until acceptance and may then
be archived. This is a migration plan, not a runtime compatibility reader.
