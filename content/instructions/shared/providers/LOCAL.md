# Local provider reference

`issues.provider: "local"` uses the logical `issues.store` registration in validated user
configuration; optional `issues.view` names a registered generated view. These roots are user or
account storage, not repository-owned data. Never derive either root from the repository or
`project.id`.

Use the supported Node entrypoint from an installed MPX workspace or application environment:

```js
import path from 'node:path';
import { discoverProjectConfig, loadUserConfig } from '@mpx/config';
import { createConfiguredNodeLocalIssueStore } from '@mpx/application/node';

const found = await discoverProjectConfig(process.cwd());
if (!found) throw new Error('No mpxconfig.json');
const appData = process.env.APPDATA;
if (!appData) throw new Error('APPDATA is required');
const user = await loadUserConfig(path.join(appData, 'mpx', 'config.json'));
const store = createConfiguredNodeLocalIssueStore({ project: found.config, user });
```

Require `APPDATA` explicitly and stop if absent. `loadUserConfig` validates and interpolates user
registrations. The application entrypoint resolves exact logical names, fails closed when either is
absent, preserves the registered absolute store root, and wires `onChanged` so successful mutations
rebuild the registered view. A rebuild failure is reported as `projectionRebuildPending`; it does
not roll back committed issue data.

Use only the public `LocalIssueStore` methods: `list([open|finished])`, `view(id)`, `create(input)`,
`update(id, patch[, expectedRevision])`, `comment(id, body)`, and
`setDependency(id, dependencyId, present[, expectedRevision])`. Retain the calling skill's read and
mutation authorization gates.

Each issue is a schema-versioned UTF-8 Markdown document indexed by `.mpx-index.json`. The component
validates IDs, indexed filenames, project and schema identity, references, symlinks, and absolute
non-private roots; writes use its lease lock and atomic files. Preserve unknown frontmatter and
content after `<!-- mpx:preserve -->`. Hosted repository creation, Review, CI, authentication,
merge, and board movement are unsupported.
