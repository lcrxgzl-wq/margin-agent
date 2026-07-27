import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeDirectPrompt,
  composeSystemPrompt,
  directIdentity,
  getHarness,
  importWorkspaceSkill,
  listAvailableSkills,
  listBundledSkills,
  listHarnesses,
  loadBundledSkill,
  loadAvailableSkill,
  removeWorkspaceSkill,
  validateAgentProfile,
  type AgentProfile,
} from "./index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("harness", () => {
  it("defaults to social-science-zh", () => {
    expect(getHarness().id).toBe("social-science-zh");
    expect(getHarness().instructions).toContain("文档写作与修订");
    expect(getHarness().instructions).toContain("证据底线");
    expect(getHarness().capabilities).toContain("review.academic");
    expect(getHarness().capabilities).toContain("analysis.tabular");
  });

  it("lists harnesses", () => {
    expect(listHarnesses().length).toBeGreaterThanOrEqual(2);
  });

  it("keeps minimal free of optional tools", () => {
    expect(getHarness("minimal").capabilities).toEqual(["document.propose"]);
    expect(getHarness("minimal").skills).toEqual({ scope: "none", direct: [] });
  });

  it("composes persona from shared skeleton + parameterized constraints", () => {
    for (const id of ["social-science-zh", "office-zh"] as const) {
      const h = getHarness(id);
      expect(h.instructions).toContain("propose_"); // 编辑契约（共享骨架）
      expect(h.instructions).toContain("选区"); // 微观选区优先（共享骨架）
    }
    expect(getHarness("office-zh").instructions).not.toContain("文献"); // 学术约束不进办公档
    expect(getHarness("office-zh").capabilities).not.toContain("review.academic");
  });

  it("exposes office-zh in registry", () => {
    expect(listHarnesses().map((h) => h.id)).toContain("office-zh");
  });

  it("directIdentity uses the selected profile constraints", () => {
    const identity = directIdentity("social-science-zh");
    expect(identity).toContain("你是 Margin");
    expect(identity).not.toContain("load_skill");
    expect(identity).toContain("禁止编造文献");
    expect(directIdentity("minimal")).not.toContain("文献");
  });

  it("rejects unknown profile ids instead of silently using academic", () => {
    expect(() => getHarness("novel")).toThrow(/Unknown agent profile/);
  });

  it("validates capability and limit boundaries", () => {
    const profile = structuredClone(getHarness("minimal")) as AgentProfile;
    profile.limits.maxTurns = 0;
    expect(() => validateAgentProfile(profile)).toThrow(/maxTurns/);
  });

  it("composeSystemPrompt is Pi-short: persona + boundary + skills index", () => {
    const session = composeSystemPrompt("social-science-zh", "session");
    expect(session).toContain("文档写作与修订");
    expect(session).toContain("风格：问题意识清晰、文献对话、克制可辩护");
    expect(session).toContain("禁止 bash");
    expect(session).toContain("available_skills");
    expect(session).toContain("argument-revision-zh");
    expect(session.match(/你是 Margin/g)?.length).toBe(1);
    expect(session).not.toContain("list_workspace_files");
    // Full skill body is not inlined — only name/description index.
    expect(session).not.toContain("## 步骤");
    expect(session).not.toContain("与 cite_check");
    // Core without skills index stays compact; with index still under ~2k.
    expect(session.length).toBeLessThan(2000);

    const scan = composeSystemPrompt("minimal", "scan");
    expect(scan).toContain("非持久化扫描");
    expect(scan).not.toContain("available_skills");
    expect(scan.length).toBeLessThan(320);
  });

  it("filters skills by harness scope", () => {
    const session = composeSystemPrompt("office-zh", "session");
    expect(session).not.toContain("argument-revision-zh");
    expect(session).not.toContain("socratic-revision-zh");
    expect(session).toContain("cascade-consistency-zh"); // core 技能保留
  });

  it("includes format-tidy-zh in both academic and office scopes", () => {
    expect(composeSystemPrompt("social-science-zh", "session")).toContain("format-tidy-zh");
    expect(composeSystemPrompt("office-zh", "session")).toContain("format-tidy-zh");
  });

  it("normalizes pack case when filtering scopes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-skills-packs-"));
    roots.push(root);
    const raw = `---\nname: case-pack-skill\ndescription: Pack case normalization check\npacks: Academic\n---\n\nBody.`;
    await importWorkspaceSkill(root, raw);

    const names = (scope: "all" | "core") => listAvailableSkills(root, scope).map((s) => s.name);
    expect(names("core")).not.toContain("case-pack-skill");
    expect(names("all")).toContain("case-pack-skill");
  });

  it("loads bundled skills", () => {
    const listed = listBundledSkills();
    expect(listed.map((s) => s.name).sort()).toEqual([
      "argument-revision-zh",
      "cascade-consistency-zh",
      "fill-table-from-csv",
      "format-tidy-zh",
      "socratic-revision-zh",
      "source-grounded-writing",
    ]);
    const skill = loadBundledSkill("source-grounded-writing");
    expect(skill.body).toContain("需插入引文");
    expect(skill.contentHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("imports and loads a workspace skill without executing files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-skills-"));
    roots.push(root);
    const raw = `---\nname: interview-coding\ndescription: Code qualitative interviews conservatively\n---\n\n## Method\nOnly use attached evidence.`;
    const imported = await importWorkspaceSkill(root, raw);

    expect(imported).toMatchObject({ name: "interview-coding", source: "workspace" });
    expect(listAvailableSkills(root).some((skill) => skill.name === "interview-coding")).toBe(true);
    expect(loadAvailableSkill("interview-coding", root).body).toContain("attached evidence");
    expect(composeSystemPrompt("social-science-zh", "session", { workspaceSkillsRoot: root }))
      .toContain("interview-coding");
    expect(composeDirectPrompt("social-science-zh", {
      workspaceSkillsRoot: root,
      instruction: "Use @interview-coding for this edit",
    })).toContain("Only use attached evidence");
    expect(composeDirectPrompt("minimal")).toContain("风格：保持原意，小幅改清晰度");
  });

  it("refuses to import through a symlinked skill directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-skills-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "margin-skills-outside-"));
    roots.push(root, outside);
    fs.symlinkSync(outside, path.join(root, "unsafe-skill"), "junction");
    const raw = `---\nname: unsafe-skill\ndescription: Must stay inside the workspace\n---\n\nDo not escape.`;

    await expect(importWorkspaceSkill(root, raw)).rejects.toThrow(/symbolic link/);
    expect(fs.existsSync(path.join(outside, "SKILL.md"))).toBe(false);
  });

  it("removes only an imported workspace skill and its empty directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-skills-remove-"));
    roots.push(root);
    const raw = `---\nname: removable-skill\ndescription: Temporary workspace method\n---\n\nRemove me safely.`;
    await importWorkspaceSkill(root, raw);

    await removeWorkspaceSkill(root, "removable-skill");

    expect(fs.existsSync(path.join(root, "removable-skill"))).toBe(false);
    expect(listAvailableSkills(root).some((skill) => skill.name === "removable-skill")).toBe(false);
  });

  it("does not delete bundled skills or linked workspace files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-skills-guard-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "margin-skills-linked-"));
    roots.push(root, outside);
    await expect(removeWorkspaceSkill(root, "argument-revision-zh")).rejects.toThrow(/not found/);
    expect(loadBundledSkill("argument-revision-zh").body).toBeTruthy();

    const linkedDir = path.join(root, "linked-skill");
    fs.mkdirSync(linkedDir);
    const outsideFile = path.join(outside, "outside.md");
    const raw = `---\nname: linked-skill\ndescription: Linked workspace method\n---\n\nDo not delete.`;
    fs.writeFileSync(outsideFile, raw, "utf8");
    fs.linkSync(outsideFile, path.join(linkedDir, "SKILL.md"));

    await expect(removeWorkspaceSkill(root, "linked-skill")).rejects.toThrow(/single-link/);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe(raw);

    const junctionTarget = path.join(outside, "junction-target");
    fs.mkdirSync(junctionTarget);
    fs.writeFileSync(
      path.join(junctionTarget, "SKILL.md"),
      `---\nname: junction-skill\ndescription: Junction workspace method\n---\n\nDo not delete.`,
      "utf8",
    );
    fs.symlinkSync(junctionTarget, path.join(root, "junction-skill"), "junction");
    await expect(removeWorkspaceSkill(root, "junction-skill")).rejects.toThrow(/real directory/);
    expect(fs.existsSync(path.join(junctionTarget, "SKILL.md"))).toBe(true);

    await expect(removeWorkspaceSkill(root, "../argument-revision-zh")).rejects.toThrow(/skill name/);
  });
});
