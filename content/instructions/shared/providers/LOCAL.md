# Local provider reference

`issues.provider: "local"` uses the logical `issues.store` registration in validated user configuration; optional `issues.view` names a registered generated view. These roots are user/account storage, not repository-owned data. Never derive either root from the repository or `project.id`.

Use the supported Node entrypoint from an installed MPX workspace/application environment (not a general provider facade):

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

Require `APPDATA` explicitly and stop if absent. `loadUserConfig` validates/interpolates the user registrations; the application entrypoint resolves exact logical names, fails closed when either is absent, preserves the registered absolute store root, and wires `onChanged` so each successful `create`, `update`, `setDependency`, or `comment` rebuilds the registered view. A rebuild failure is reported on the returned issue as `projectionRebuildPending`; it does not roll back committed issue data.

Use only the public `LocalIssueStore` methods: `list([open|finished])`, `view(id)`, `create(input)`, `update(id, patch[, expectedRevision])`, `comment(id, body)`, and `setDependency(id, dependencyId, present[, expectedRevision])`. The caller must retain its read/mutation authorization gate.

Each issue is a `schemaVersion: 2` UTF-8 Markdown document indexed by a `schemaVersion: 1` `.mpx-index.json`. The component validates IDs, indexed filenames, project/schema, references, symlinks, and absolute non-private roots; writes use its lease lock and atomic files. Preserve unknown frontmatter and content after `<!-- mpx:preserve -->`. Hosted repository creation, Review, CI, authentication, and merge are unsupported.
