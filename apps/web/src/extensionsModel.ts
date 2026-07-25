export type ExtensionSkill = {
  name: string;
  source: "bundled" | "workspace";
};

export type ExtensionMcpTool = {
  name: string;
  description: string;
  readOnly?: boolean;
};

export type ExtensionMcpServer = {
  id: string;
  name: string;
  url: string;
  tokenSet: boolean;
  enabledTools: ExtensionMcpTool[];
};

export type McpDraft = {
  editingServerId: string | null;
  storedTokenAvailable: boolean;
  name: string;
  url: string;
  token: string;
  clearToken: boolean;
  tools: ExtensionMcpTool[];
  selectedTools: string[];
  restoreEnabledTools: string[];
  latencyMs: number | null;
};

export function emptyMcpDraft(): McpDraft {
  return {
    editingServerId: null,
    storedTokenAvailable: false,
    name: "",
    url: "",
    token: "",
    clearToken: false,
    tools: [],
    selectedTools: [],
    restoreEnabledTools: [],
    latencyMs: null,
  };
}

export function groupSkills<T extends ExtensionSkill>(skills: T[]): {
  bundled: T[];
  workspace: T[];
} {
  return {
    bundled: skills.filter((skill) => skill.source === "bundled"),
    workspace: skills.filter((skill) => skill.source === "workspace"),
  };
}

export function skillNameFromContent(content: string): string | null {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const rawName = frontmatter?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  if (!rawName) return null;
  const quoted = rawName.match(/^(?:"([^"]+)"|'([^']+)')$/);
  return (quoted?.[1] ?? quoted?.[2] ?? rawName).trim() || null;
}

export function findWorkspaceSkillOverwrite<T extends ExtensionSkill>(
  skills: T[],
  content: string,
): T | null {
  const name = skillNameFromContent(content);
  if (!name) return null;
  return skills.find((skill) => skill.source === "workspace" && skill.name === name) ?? null;
}

export function editMcpServer(server: ExtensionMcpServer): McpDraft {
  const enabledTools = server.enabledTools.map((tool) => tool.name);
  const tools = server.enabledTools.map((tool) => ({ ...tool, readOnly: true }));
  return {
    editingServerId: server.id,
    storedTokenAvailable: server.tokenSet,
    name: server.name,
    url: server.url,
    token: "",
    clearToken: false,
    tools,
    selectedTools: enabledTools,
    restoreEnabledTools: enabledTools,
    latencyMs: null,
  };
}

export function changeMcpUrl(draft: McpDraft, url: string): McpDraft {
  const leftStoredServer = draft.editingServerId !== null && url !== draft.url;
  return {
    ...draft,
    editingServerId: leftStoredServer ? null : draft.editingServerId,
    storedTokenAvailable: leftStoredServer ? false : draft.storedTokenAvailable,
    restoreEnabledTools: leftStoredServer ? [] : draft.restoreEnabledTools,
    token: leftStoredServer ? "" : draft.token,
    clearToken: leftStoredServer ? false : draft.clearToken,
    url,
    tools: [],
    selectedTools: [],
    latencyMs: null,
  };
}

export function applyMcpDiscovery(
  draft: McpDraft,
  result: { url: string; tools: ExtensionMcpTool[]; latencyMs: number },
): McpDraft {
  const selectable = new Set(
    result.tools.filter((tool) => tool.readOnly).map((tool) => tool.name),
  );
  const desiredSelection = draft.tools.length
    ? draft.selectedTools
    : draft.restoreEnabledTools;
  const leftStoredServer = draft.editingServerId !== null && result.url !== draft.url;
  return {
    ...draft,
    editingServerId: leftStoredServer ? null : draft.editingServerId,
    storedTokenAvailable: leftStoredServer ? false : draft.storedTokenAvailable,
    restoreEnabledTools: leftStoredServer ? [] : draft.restoreEnabledTools,
    token: leftStoredServer ? "" : draft.token,
    clearToken: leftStoredServer ? false : draft.clearToken,
    url: result.url,
    tools: result.tools,
    selectedTools: desiredSelection.filter((name) => selectable.has(name)),
    latencyMs: result.latencyMs,
  };
}

export function mcpDiscoverPayload(draft: McpDraft): {
  url: string;
  token?: string;
  serverId?: string;
} {
  return {
    url: draft.url.trim(),
    token: draft.token.trim() || undefined,
    serverId: draft.clearToken ? undefined : draft.editingServerId || undefined,
  };
}
