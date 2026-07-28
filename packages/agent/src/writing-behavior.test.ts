import { describe, expect, it } from "vitest";
import { loadBundledSkill } from "@margin/harness";
import { createSessionTools, type SessionDocBag } from "./session-tools.js";

/**
 * Behavior gate (no LLM): skills encode evidence discipline;
 * tools refuse canonical overwrite; load_skill surfaces method text.
 */
describe("writing-agent behavior gate", () => {
  it("source-grounded skill forbids fake citations", () => {
    const skill = loadBundledSkill("source-grounded-writing");
    expect(skill.body).toMatch(/假|虚构|禁止/);
    expect(skill.body).toContain("需插入引文");
    expect(skill.body).not.toMatch(/直接 apply|bash /i);
  });

  it("argument-revision skill requires read-then-propose", () => {
    const skill = loadBundledSkill("argument-revision-zh");
    expect(skill.body).toContain("propose_block_edit");
    expect(skill.body).toMatch(/最小/);
  });

  it("load_skill records name and hash on effects", async () => {
    const bag: SessionDocBag = { revision: 0, blocks: [] };
    const effects: import("./session-tools.js").SessionSideEffects = {};
    const tools = createSessionTools(
      {
        listSourceFiles: () => [],
        readText: () => ({ relativePath: "", text: "", bytes: 0 }),
        writeText: async (relativePath, content) => ({
          relativePath,
          bytes: content.length,
          created: true,
        }),
        openDocument: () => {
          throw new Error("unused");
        },
      },
      bag,
      [],
      [],
      effects,
    );
    const load = tools.find((t) => t.name === "load_skill")!;
    await load.execute("1", { name: "argument-revision-zh" });
    expect(effects.loadedSkills?.[0]?.name).toBe("argument-revision-zh");
    expect(effects.loadedSkills?.[0]?.contentHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("load_skill rejects persistently disabled skills visibly", async () => {
    const bag: SessionDocBag = { revision: 0, blocks: [] };
    const effects: import("./session-tools.js").SessionSideEffects = {};
    const tools = createSessionTools(
      {
        listSourceFiles: () => [],
        readText: () => ({ relativePath: "", text: "", bytes: 0 }),
        writeText: async (relativePath, content) => ({
          relativePath,
          bytes: content.length,
          created: true,
        }),
        openDocument: () => {
          throw new Error("unused");
        },
      },
      bag,
      [],
      [],
      effects,
      { harnessId: "social-science-zh", disabledSkills: ["argument-revision-zh"] },
    );
    const load = tools.find((t) => t.name === "load_skill")!;
    await expect(load.execute("1", { name: "argument-revision-zh" }))
      .rejects.toThrow(/Skill 已关闭/);
    expect(effects.loadedSkills ?? []).toEqual([]);
    // Non-disabled skills still load.
    await load.execute("2", { name: "cascade-consistency-zh" });
    expect(effects.loadedSkills?.[0]?.name).toBe("cascade-consistency-zh");
  });
});
