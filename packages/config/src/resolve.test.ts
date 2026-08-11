import { expect, it, vi } from "vitest";
import { classifyScope, resolveConfig } from "./resolve.js";
import type { ProjectConfig, UserConfig } from "./types.js";

vi.mock("node:fs/promises", () => ({
  realpath: async (value: string) => {
    if (value === "C:/stale") throw new Error("missing");
    return value;
  },
}));

const project: ProjectConfig = {
  schemaVersion: 1,
  project: { id: "acme/app" },
  repository: { provider: "github", remote: "origin" },
};

it("uses the longest canonical root and deterministic overrides", async () => {
  const user: UserConfig = {
    scopes: {
      work: { roots: ["C:/_MP_work"], skillPacks: ["core"] },
      nested: {
        roots: ["C:/_MP_work/team"],
        skillPacks: ["work"],
        skillExposure: { skills: { review: "full" } },
      },
    },
    projects: {
      "acme/app": {
        skillPacks: ["personal"],
        skillExposure: { default: "name-only" },
      },
    },
  };
  const first = await resolveConfig(project, user, "C:/_MP_work/team/repo");
  const second = await resolveConfig(project, user, "C:/_MP_work/team/repo");

  expect(first.scope.name).toBe("nested");
  expect(first.scope.skillPacks).toEqual(["personal"]);
  expect(first.scope.skillExposure).toEqual({ skills: { review: "full" } });
  expect(first.scope.projectSkillExposure).toEqual({ default: "name-only" });
  expect(first).toEqual(second);
  expect(first.project.issues).toEqual({ provider: "none" });
  expect(first.provenance.map(({ pointer }) => pointer)).toEqual(
    [...first.provenance.map(({ pointer }) => pointer)].sort(),
  );
});

it("does not classify against unresolvable lexical roots", async () => {
  const user: UserConfig = { scopes: { stale: { roots: ["C:/stale"] } } };
  expect(await classifyScope("C:/stale/repo", user)).toEqual({ name: "core" });
});
