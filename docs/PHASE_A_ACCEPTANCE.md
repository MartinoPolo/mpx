# Phase A remediation acceptance

Phase A closes the reviewed baseline-capture and repository-byte-control gaps without changing native integrations.

## Baseline qualification

Historical personal/work runtime `settings.json` entries were captured as mutable symlink aliases to a shared symbolic source. Those historical snapshots were not repaired or rewritten and are not claimed to be repairable. The reviewed disposable drill verified every recorded repository restoration. Raw machine-local evidence remains outside Git. A fresh schema-2 checkpoint was generated after remediation and locally attested, closing the file-backed fresh-checkpoint qualification.

Future schema-2 captures materialize an approved file symlink as immutable regular-file bytes and record its original node type, raw target, resolved target, and content hash. Candidate-specific target allowlists, regular-target checks, top-level directory-link rejection, and identity rechecks make capture fail closed. Directory archives preserve nested link metadata without traversing top-level directory links. Native credentials, provider tokens, session stores, caches, and unrelated private state remain excluded.

Historical schema-1 manifests remain understandable as records of the earlier format: their `files` entries contain source, destination, and hash but do not attest to original node topology. They must not be interpreted as schema-2 immutable-symlink evidence.

## Deferred integration gates

Live native restore is deferred to the reviewed Phase I/J integration classes. Those classes also own before-mutation snapshots immediately before any native integration change. Phase A neither restores live integrations nor claims those later gates. Paths in acceptance and review material use symbolic roots such as `${MPX_PROJECTS}`, `${LOCALAPPDATA}`, and `${USER_HOME}` only.
