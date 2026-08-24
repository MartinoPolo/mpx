import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inventoryCanonical } from "../src/index.js";

const canonicalRoot = path.resolve(import.meta.dirname, "../../../content/skills");
const workflowSkills = ["execute", "issue-create", "issue-refine", "issue-view", "review", "ship"] as const;
const providerGuidanceMatrix = [
  ["execute", "issue"],
  ["issue-create", "issue"],
  ["issue-refine", "issue"],
  ["issue-view", "issue"],
  ["review", "issue"],
  ["review", "review"],
  ["review", "ci"],
  ["ship", "review"],
  ["ship", "ci"],
] as const;

function providerOperationCommands(content: string): string[] {
  return [...content.matchAll(/\bmpx\s+(?:issue|review|ci)\s+[a-z][^`\n]*/gu)].map(match => match[0]!.trim());
}

async function normalizedSkill(identity: string): Promise<string> {
  return (await readFile(path.join(canonicalRoot, identity, "SKILL.md"), "utf8")).replace(/\r\n/gu, "\n");
}

async function body(identity: string): Promise<string> {
  const text = await normalizedSkill(identity);
  const end = text.indexOf("\n---\n", 4);
  return text.slice(end + 5);
}

describe("canonical provider-neutral workflow skills", () => {
  it("loads the bounded workflow family through the canonical catalog", async () => {
    const catalog = await inventoryCanonical(canonicalRoot);
    expect(catalog.map((skill) => skill.identity)).toEqual([...workflowSkills].sort());
  });

  it.each(providerGuidanceMatrix)("includes provider-neutral mpx %s %s guidance", async (identity, commandGroup) => {
    const commands = providerOperationCommands(await body(identity));
    expect(commands.some(command => command.startsWith(`mpx ${commandGroup} `))).toBe(true);
  });

  it.each(workflowSkills)("binds every concrete provider command in %s to the immutable launch identity and JSON output", async identity => {
    const content = await body(identity);
    const commands = providerOperationCommands(content);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter(command => !command.includes("--identity <launch-identity>") || !command.includes("--json"))).toEqual([]);
    expect(content).toContain("immutable identity selected when MPX launched");
    expect(content).toContain("If the launch identity is unavailable, stop and ask the user");
  });

  it("uses explicit Review and CI identifiers and complete Review creation inputs in ship", async () => {
    const content = await body("ship");
    const commands = providerOperationCommands(content);
    for (const action of ["view", "update", "ready", "merge"]) {
      expect(commands.find(command => command.startsWith(`mpx review ${action} `))).toContain("--id <review-id>");
    }
    const create = commands.find(command => command.startsWith("mpx review create "))!;
    for (const flag of ["--title <title>", "--body <body>", "--source-branch <source-branch>", "--target-branch <target-branch>"]) expect(create).toContain(flag);
    for (const action of ["status", "watch"]) expect(commands.find(command => command.startsWith(`mpx ci ${action} `))).toContain("--id <review-or-pipeline-id>");
    for (const action of ["logs", "retry"]) expect(commands.find(command => command.startsWith(`mpx ci ${action} `))).toContain("--run-id <run-id>");
    expect(content).toContain("There is no implicit Review or CI discovery");
    expect(content).toContain("capture the returned Review ID");
  });

  it("keeps workflow bodies provider-neutral, portable, and on current vocabulary", async () => {
    const violations: string[] = [];
    for (const identity of workflowSkills) {
      const content = await normalizedSkill(identity);
      const forbidden: Array<[string, RegExp]> = [
        ["provider CLI invocation", /(?:^|[\n`$;|&])\s*(?:gh|glab|kf)(?:\.exe)?\s+(?=[a-z-])/imu],
        ["provider comparison table", /^(?:\s*\|[^\n]*(?:provider[^\n]*command|command[^\n]*provider|GitHub|GitLab|KanbanFlow)[^\n]*\|\s*)$/imu],
        ["non-Issue vocabulary", /\b(?:tasks?|tickets?)\b/iu],
        ["legacy identity", /\/(?:mp(?:-gh)?|kf):[a-z0-9-]+/iu],
        ["runtime placeholder", /(?:\$ARGUMENTS|\$\{[^}]+\}|\{\{[^}]+\}\})/u],
        ["absolute path", /(?:\b[A-Za-z]:[\\/]|\/(?:Users|home|_MP_projects|_MP_work|_MP_apps)\/)/u],
      ];
      for (const [kind, pattern] of forbidden) if (pattern.test(content)) violations.push(`${identity}: ${kind}`);
    }
    expect(violations).toEqual([]);
  });
});
