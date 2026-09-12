import { readFile } from 'node:fs/promises';
import { DefaultResourceLoader, SettingsManager, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';

const options = JSON.parse(process.argv[2]!) as { cwd: string; account: string; skillPaths: string[]; trusted: boolean };
const settings = SettingsManager.create(options.cwd, options.account);
settings.setProjectTrusted(options.trusted);
const loader = new DefaultResourceLoader({
  cwd: options.cwd, agentDir: options.account, settingsManager: settings,
  additionalSkillPaths: options.skillPaths,
  noExtensions: true, noPromptTemplates: true, noThemes: true,
});
await loader.reload();
const result = loader.getSkills();
console.log(JSON.stringify({
  skills: result.skills.map(skill => ({ name: skill.name, description: skill.description, filePath: skill.filePath, hidden: skill.disableModelInvocation })),
  prompt: formatSkillsForPrompt(result.skills),
  diagnostics: result.diagnostics,
  contexts: loader.getAgentsFiles().agentsFiles.map(file => file.path),
  extensions: loader.getExtensions().extensions.map(extension => extension.path),
  // Reading here verifies exact native-resolved files, not LLM or interactive invocation.
  bodies: await Promise.all(result.skills.map(async skill => ({ name: skill.name, body: await readFile(skill.filePath, 'utf8') }))),
}));
