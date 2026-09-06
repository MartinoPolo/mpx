# Session lifecycle

MPX lifecycle events remain authoritative for sessions they represent. The public CLI exposes only native session listing and resume:

```text
mpx session list
mpx session resume <id>
```

Pi native bindings are account-unenrolled unless setup has established an account-binding enrollment. Resume requires current binding verification and fails closed on absent, unavailable, mismatched, or duplicate verification. Resurrection additionally requires its explicit one-use authority; internal bounded resurrection export is not part of public help or generated references.

Legacy discovery, import, branch, reconcile, and workflow-marking routes are not CLI operations.
