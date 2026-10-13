# Project Documentation Initialization

Create missing `.mpx/CONTEXT.md` and `.mpx/DECISIONS.md`; preserve substantive existing content.

- **CONTEXT.md:** use a project-context title and a concise summary supported by known facts. Add
  populated sections as needed: Domain Language (one `- **Term** — Definition.` list item per term),
  Flagged Ambiguities, and Features (a compact `### Done` list and `### Planned` with Issue links).
  Constraints and their rationale belong in DECISIONS.md. Do not invent facts or leave instructional
  placeholders.
- **DECISIONS.md:** use `# Decisions`. Add domain headings and concise decision bullets only for
  confirmed choices, with useful rationale and only explicitly rejected alternatives.

If no substantive content is known, leave only the document title. Do not recreate or fall back to
retired REQUIREMENTS, VOCABULARY, or ARCHITECTURE documents.
