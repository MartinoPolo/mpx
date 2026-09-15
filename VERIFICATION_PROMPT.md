# Quick MPX capability test

Verify this session’s configuration and capabilities as quickly as possible. **Test what is already
exposed; do not investigate how the system was installed.**

Use current context as the source of truth for advertised instructions, skills, agents, and tools.
Use actual tool calls to verify execution.

**On failure, stop that test without workarounds and continue the others.** Do not repair anything,
change PATH, install dependencies, search other installations, or substitute tools. Report
everything once at the end.

## 1. What is already in context?

Before loading anything else, list:

- Instruction-file paths explicitly identified in your current context, including `AGENTS.md` and
  equivalents.
- Skills grouped into:
  - Body already loaded.
  - Description present, but body not loaded.
  - Name/command only.
- Advertised named agents.
- Available tools and MCP servers.

Do not search the filesystem or infer loading from configuration. If a source path is not exposed,
say **“path not exposed.”** Do not reproduce instruction bodies or protected messages.

Keep this initial inventory separate from anything loaded during the following tests.

## 2. Environment and executables

Read the actual process environment and list **every `MPX_*` variable**. Redact secrets and
summarize structured instruction/context payloads.

For path values, show the literal absolute path and whether it exists with the expected
file/directory type. Resolve environment references before passing paths to file tools. Do not
recursively explore the directories.

Explicitly include these roots, even if unset:

- `MPX_PROJECTS`
- `MPX_WORK`
- `MPX_CLONED`
- `MPX_APPS`
- `MPX_ONEDRIVE`
- `MPX_AI_GENERATED`
- `MPX_OBSIDIAN_VAULT`

Flag unresolved placeholders, relative paths, inaccessible paths, and disagreements with values
supplied in context. Do not assume every optional variable must be set.

Briefly report the actual shell, working directory, runtime, and exposed model/session metadata.

Check executable resolution and harmless version execution for **`mpx`, `node`, and `pnpm`**. Also
check the project’s package manager if the skill below identifies a different one. No downloads or
alternate executable routes.

## 3. Invoke two skills

Use the supported skill-invocation mechanism. If this harness loads skills through file reads
instead of native command dispatch, report that distinction.

### `/mpx:script-discovery`

Invoke it for the current project, using its default nonrecursive mode.

Report:

- Exact skill-file path loaded.
- Exact bundled-script path executed.
- Which environment value or relative reference resolved that path.
- Detected package manager and recommended development-server command.

Do not run project checks or start the server as part of this skill.

### `/mpx:grill`

Invoke it with this deliberately bounded request:

> Grill me about naming a temporary test fixture. Perform only the initial context/reference loading
> and produce one relevant question. Do not explore the codebase, delegate, or update documents.

Include that question in the final report; do not wait for an answer.

Report the exact skill path and shared-reference paths actually read, particularly the
documentation-strategy reference. State whether they resolve inside the active compiled content
rather than a guessed source checkout.

For both skills, record whether they were advertised in the initial context or discovered only
through explicit invocation. If neither tests an initially unadvertised skill, make **one supported
catalog lookup** for additional available skills. List newly discovered names without loading their
bodies. Do not search installation directories.

## 4. Spawn two small agents

All diagnostic subagents must use **Luna in Pi** or **Haiku in Claude Code**, selected through the
actual structured model parameter using an exposed supported identifier. Prose instructions alone do
not select a model.

If that model cannot be selected, report the limitation; do not silently use another model.

Make two independent calls, concurrently if supported:

1. Named agent: **`mpx-checker`**
2. An **unnamed/default general-purpose agent**, using the harness’s native generic delegation
   mode—not an MPX named-agent substitute.

Give both the same task:

> Use your shell tool to report your actual working directory, resolve `MPX_CLONED` from your
> environment, and run `pnpm --version`. Return bounded output and any error. Do not explore,
> repair, write files, or delegate.

Do not supply the expected environment values.

Report requested agent/model, actual execution metadata where exposed, completion/result delivery,
and agreement with the parent environment. If generic delegation is unavailable, mark that test
unsupported.

## 5. One browser smoke test

Use **Chrome DevTools MCP**, not a substitute.

Use an existing local application if its URL and checkout are verified. Otherwise, start **one**
existing development server or Storybook discovered in `package.json` and referenced configuration,
using the required server-management mechanism. Follow the shared dev-server startup policy: missing
MPX port metadata does not block project defaults. Use the actual server URL.

Do not install dependencies, invent an application, guess ports, or take over an existing process.

Through Chrome DevTools MCP:

1. Open the application.
2. Take one screenshot.
3. Briefly describe what is visible in its top-right corner, based only on the live browser
   evidence.

No interactions, console/network investigation, geometry calculations, or source-code inference are
needed.

Stop any server and close any page created by this test. If no suitable application exists, report
the browser test as blocked while reporting MCP discovery separately.

## Final report

Keep it compact:

1. **Problems first:** exact failures, confusing names, unresolved paths, unavailable capabilities,
   or mistakes made during testing.
2. **Initial context inventory:** instruction paths, categorized skills, agents, and tools.
3. **Environment table:** all observed `MPX_*` variables, resolved paths, and validation results.
4. **Execution table:** skill calls, named agent, generic agent, executable checks, and browser
   test—each marked **PASS / FAIL / BLOCKED / UNSUPPORTED**, with short evidence.
5. **Leftovers**, if any.

Do not present advertised capabilities as executed successfully. Do not hide first-attempt failures
or claim paths were loaded merely because they exist.
