import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (!process.env.MPX_PROJECTS) throw new Error('MPX_PROJECTS is required; no source root is guessed.');
const sourceRoot = path.join(process.env.MPX_PROJECTS, 'mpx');
const reviewerNames = [
  'best-practices',
  'code-quality',
  'error-handling',
  'performance',
  'security',
  'spec-alignment',
  'test-quality',
];
const referenceNames = ['typescript', 'react', 'svelte', 'python', 'rust'];
const reviewerSources = reviewerNames.map(name => path.join(sourceRoot, 'content/agents', `mpx-reviewer-${name}.md`));
const reviewerDestinations = reviewerNames.map(name => path.join(root, 'content/agents', `reviewer-${name}.md`));
const referenceSources = referenceNames.map(name => path.join(sourceRoot, 'content/agents/references', `${name}-review.md`));
const referenceDestinations = referenceNames.map(name => path.join(root, 'content/agents/references', `${name}-review.md`));
const protocolSource = path.join(sourceRoot, 'content/instructions/shared/REVIEWER_PROTOCOL.md');
const protocolDestination = path.join(root, 'content/instructions/shared/REVIEWER_PROTOCOL.md');
const destinations = [...reviewerDestinations, ...referenceDestinations, protocolDestination];

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

for (const destination of destinations) {
  if (await exists(destination)) throw new Error(`Refusing to overwrite existing destination: ${destination}`);
}

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/;
const commonProtocol = `Resolve \`MPX_ACTIVE_CONTENT_ROOT\` from the environment once to an absolute literal path, then read the
[Reviewer Protocol]({{MPX_SHARED_INSTRUCTIONS}}/REVIEWER_PROTOCOL.md) at
\`<resolved-root>/dist/{{MPX_HARNESS}}/instructions/shared/REVIEWER_PROTOCOL.md\` and follow it for
scope and output format. If the environment variable is unset, request a parent-resolved absolute
path; never guess or search.`;
const originalProtocolParagraphs = [
  `Resolve the declared loaded content base, or \`MPX_ACTIVE_CONTENT_ROOT\` when set, once to an absolute
literal path, then read \`skills/shared/REVIEWER_PROTOCOL.md\` beneath that same root and follow it
for scope and output format. If neither root is available, request a parent-resolved absolute path;
never search or guess.`,
  `Resolve the declared loaded content base, or \`MPX_ACTIVE_CONTENT_ROOT\` when set, once to an absolute
literal path. Read \`skills/shared/REVIEWER_PROTOCOL.md\` beneath that exact root and follow it for
scope and output format. If neither root is available, request a parent-resolved absolute path;
never search or guess.`,
];

function adaptReviewer(source, name) {
  const match = source.match(frontmatter);
  if (!match) throw new Error(`Reviewer ${name} source has no frontmatter.`);
  if (!new RegExp(`^name:\\s*mpx-reviewer-${name}\\s*$`, 'm').test(match[1])) {
    throw new Error(`Reviewer ${name} has an unexpected source name.`);
  }
  const metadata = 'metadata:\n  mpx:\n    schemaVersion: 1\n    modelClass: standard\n    thinking: medium\n    capabilities: [read, search, shell]';
  let adapted = source.replace(frontmatter, (_, body) =>
    `---\n${body}${body.endsWith('\n') ? '' : '\n'}${metadata}\n---`,
  ).replace(new RegExp(`^name: mpx-reviewer-${name}$`, 'm'), `name: reviewer-${name}`);
  const matchingProtocolParagraphs = originalProtocolParagraphs.filter(paragraph => adapted.includes(paragraph));
  if (matchingProtocolParagraphs.length !== 1) {
    throw new Error(`Reviewer ${name} protocol paragraph match count was ${matchingProtocolParagraphs.length}.`);
  }
  adapted = adapted.replace(matchingProtocolParagraphs[0], commonProtocol);

  if (name === 'best-practices') {
    const oldReferences = `Detect frameworks from file extensions in the diff. Read ONLY the relevant guide(s), resolving every
path below from the same known content root:

- \`.ts\` / \`.tsx\` / \`.js\` / \`.jsx\` → Read \`agents/references/typescript-review.md\`
- \`.tsx\` / \`.jsx\` or React imports → also Read \`agents/references/react-review.md\`
- \`.svelte\` → Read \`agents/references/svelte-review.md\`
- \`.py\` → Read \`agents/references/python-review.md\`
- \`.rs\` → Read \`agents/references/rust-review.md\``;
    const newReferences = `Detect frameworks from file extensions in the diff. Read ONLY the relevant guide(s). Resolve each
actual guide path from the same root as
\`<resolved-root>/dist/{{MPX_HARNESS}}/agents/references/<name>-review.md\`:

- \`.ts\` / \`.tsx\` / \`.js\` / \`.jsx\` → Read the [TypeScript review guide]({{MPX_AGENT_REFERENCES}}/typescript-review.md)
- \`.tsx\` / \`.jsx\` or React imports → also read the [React review guide]({{MPX_AGENT_REFERENCES}}/react-review.md)
- \`.svelte\` → Read the [Svelte review guide]({{MPX_AGENT_REFERENCES}}/svelte-review.md)
- \`.py\` → Read the [Python review guide]({{MPX_AGENT_REFERENCES}}/python-review.md)
- \`.rs\` → Read the [Rust review guide]({{MPX_AGENT_REFERENCES}}/rust-review.md)`;
    if (!adapted.includes(oldReferences)) throw new Error('Best-practices reference block did not match exactly.');
    adapted = adapted.replace(oldReferences, newReferences);
  }
  return adapted;
}

const reviewerTexts = await Promise.all(reviewerSources.map(file => fs.readFile(file, 'utf8')));
const adaptedReviewers = reviewerTexts.map((text, index) => adaptReviewer(text, reviewerNames[index]));
for (const directory of [path.join(root, 'content/agents/references'), path.dirname(protocolDestination)]) {
  await fs.mkdir(directory, { recursive: true });
}
await Promise.all(referenceSources.map((source, index) => fs.copyFile(source, referenceDestinations[index])));
await fs.copyFile(protocolSource, protocolDestination);
await Promise.all(adaptedReviewers.map((text, index) => fs.writeFile(reviewerDestinations[index], text)));

const byteEqual = {};
for (let index = 0; index < referenceNames.length; index += 1) {
  byteEqual[`${referenceNames[index]}-review.md`] = (await fs.readFile(referenceSources[index])).equals(
    await fs.readFile(referenceDestinations[index]),
  );
}
byteEqual['REVIEWER_PROTOCOL.md'] = (await fs.readFile(protocolSource)).equals(await fs.readFile(protocolDestination));
const checkpointsEqual = {};
const bodySuffixEqualExceptAdaptations = {};
const bodyTransformationExact = {};
for (let index = 0; index < reviewerNames.length; index += 1) {
  const source = reviewerTexts[index];
  const destinationText = await fs.readFile(reviewerDestinations[index], 'utf8');
  const sourceCheckpoints = source.includes('\n## Checkpoints')
    ? source.slice(source.indexOf('\n## Checkpoints'), source.indexOf('\n## ', source.indexOf('\n## Checkpoints') + 4) === -1
      ? undefined
      : source.indexOf('\n## ', source.indexOf('\n## Checkpoints') + 4))
    : '';
  const destinationCheckpoints = destinationText.includes('\n## Checkpoints')
    ? destinationText.slice(destinationText.indexOf('\n## Checkpoints'), destinationText.indexOf('\n## ', destinationText.indexOf('\n## Checkpoints') + 4) === -1
      ? undefined
      : destinationText.indexOf('\n## ', destinationText.indexOf('\n## Checkpoints') + 4))
    : '';
  checkpointsEqual[reviewerNames[index]] = sourceCheckpoints === destinationCheckpoints;
  const destinationHeadingStart = destinationText.indexOf('\n## ', destinationText.indexOf('# Reviewer:'));
  const adaptedHeadingStart = adaptedReviewers[index].indexOf('\n## ', adaptedReviewers[index].indexOf('# Reviewer:'));
  bodySuffixEqualExceptAdaptations[reviewerNames[index]] = destinationHeadingStart !== -1
    && adaptedHeadingStart !== -1
    && destinationText.slice(destinationHeadingStart) === adaptedReviewers[index].slice(adaptedHeadingStart);
  bodyTransformationExact[reviewerNames[index]] = destinationText === adaptedReviewers[index];
}
if (Object.values(byteEqual).some(equal => !equal)
  || Object.values(checkpointsEqual).some(equal => !equal)
  || Object.values(bodySuffixEqualExceptAdaptations).some(equal => !equal)
  || Object.values(bodyTransformationExact).some(equal => !equal)) {
  throw new Error('Post-transfer verification failed.');
}
console.log(JSON.stringify({ count: destinations.length, byteEqual, checkpointsEqual, bodySuffixEqualExceptAdaptations, bodyTransformationExact }, null, 2));
