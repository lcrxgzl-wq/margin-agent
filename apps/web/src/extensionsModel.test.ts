import { describe, expect, it } from "vitest";
import {
  applyMcpDiscovery,
  changeMcpUrl,
  editMcpServer,
  findWorkspaceSkillOverwrite,
  groupSkills,
  mcpDiscoverPayload,
  mentionableSkills,
  skillNameFromContent,
  skillStateLabel,
  skillToggleTarget,
} from "./extensionsModel";

describe("extensions model", () => {
  it("separates bundled and workspace skills", () => {
    const grouped = groupSkills([
      { name: "argument", source: "bundled" as const },
      { name: "local-method", source: "workspace" as const },
    ]);
    expect(grouped.bundled.map((skill) => skill.name)).toEqual(["argument"]);
    expect(grouped.workspace.map((skill) => skill.name)).toEqual(["local-method"]);
  });

  it("finds a workspace Skill that an import would overwrite", () => {
    const skills = [
      { name: "argument", source: "bundled" as const },
      { name: "local-method", source: "workspace" as const },
    ];
    const content = "---\nname: local-method\ndescription: Local method\n---\n\nBody";
    expect(findWorkspaceSkillOverwrite(skills, content)).toEqual(skills[1]);
    expect(findWorkspaceSkillOverwrite(
      skills,
      content.replace("local-method", "argument"),
    )).toBeNull();
  });

  it("reads quoted Skill names and rejects malformed frontmatter", () => {
    expect(skillNameFromContent("---\nname: 'local-method'\ndescription: Local\n---\nBody"))
      .toBe("local-method");
    expect(skillNameFromContent('---\r\nname: "local-method"\r\ndescription: Local\r\n---\r\nBody'))
      .toBe("local-method");
    expect(skillNameFromContent("name: local-method\n---\nBody")).toBeNull();
    expect(skillNameFromContent("---\ndescription: Missing name\n---\nBody")).toBeNull();
  });

  it("reuses a stored token only while editing the exact saved URL", () => {
    const editing = editMcpServer({
      id: "server-1",
      name: "Archive",
      url: "https://example.test/mcp",
      tokenSet: true,
      enabledTools: [{ name: "search", description: "Search", readOnly: true }],
    });
    expect(mcpDiscoverPayload(editing)).toEqual({
      url: "https://example.test/mcp",
      token: undefined,
      serverId: "server-1",
    });
    expect(editing.tools[0]?.readOnly).toBe(true);

    const clearing = { ...editing, clearToken: true };
    expect(mcpDiscoverPayload(clearing)).toEqual({
      url: "https://example.test/mcp",
      token: undefined,
      serverId: undefined,
    });

    const changed = changeMcpUrl(
      { ...editing, token: "temporary-token" },
      "https://other.test/mcp",
    );
    expect(mcpDiscoverPayload(changed)).toEqual({
      url: "https://other.test/mcp",
      token: undefined,
      serverId: undefined,
    });
    expect(changed.storedTokenAvailable).toBe(false);
    expect(changed.token).toBe("");
  });

  it("restores only previously enabled tools that remain read-only", () => {
    const editing = editMcpServer({
      id: "server-1",
      name: "Archive",
      url: "https://example.test/mcp",
      tokenSet: true,
      enabledTools: [
        { name: "search", description: "Search", readOnly: true },
        { name: "removed", description: "Old tool", readOnly: true },
      ],
    });
    const discovered = applyMcpDiscovery(editing, {
      url: editing.url,
      latencyMs: 18,
      tools: [
        { name: "search", description: "Search", readOnly: true },
        { name: "write", description: "Write", readOnly: false },
      ],
    });
    expect(discovered.selectedTools).toEqual(["search"]);
    expect(discovered.latencyMs).toBe(18);

    const reread = applyMcpDiscovery(
      { ...discovered, selectedTools: [] },
      { ...discovered, tools: discovered.tools, latencyMs: 22 },
    );
    expect(reread.selectedTools).toEqual([]);

    const redirected = applyMcpDiscovery(editing, {
      url: `${editing.url}/`,
      tools: discovered.tools,
      latencyMs: 20,
    });
    expect(redirected.editingServerId).toBeNull();
    expect(redirected.storedTokenAvailable).toBe(false);
  });
  it("labels effective skill states and computes toggle targets", () => {
    expect(skillStateLabel("enabled")).toBe("启用");
    expect(skillStateLabel("disabled")).toBe("已关闭");
    expect(skillStateLabel("blocked_by_profile")).toBe("当前模式不可用");
    expect(skillToggleTarget("auto")).toBe("off");
    expect(skillToggleTarget("off")).toBe("auto");
  });

  it("offers only enabled skills to the chat mention picker, filtered by query", () => {
    const skills = [
      { name: "argument-revision-zh", state: "enabled" as const },
      { name: "format-tidy-zh", state: "disabled" as const },
      { name: "socratic-revision-zh", state: "blocked_by_profile" as const },
      { name: "argument-revision-zh", state: "enabled" as const },
    ];
    expect(mentionableSkills(skills, "").map((skill) => skill.name))
      .toEqual(["argument-revision-zh"]);
    expect(mentionableSkills(skills, "format")).toEqual([]);
  });
});
