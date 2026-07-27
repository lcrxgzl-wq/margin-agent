export type Block = {
  id: string;
  kind: string;
  text: string;
  order: number;
  contentHash: string;
};

export type DocumentMeta = {
  id: string;
  relativePath: string;
  revision: number;
  contentHash: string;
};

export type Proposal = {
  id: string;
  documentId: string;
  blockId: string;
  baseRevision: number;
  before: string;
  after: string;
  rationale: string;
  risk: string;
  evidence?: string[];
  status: string;
  baseHash: string;
  operation?: {
    kind: "rewrite" | "translate" | "polish";
    scope: "selection" | "block";
    targetLanguage?: "zh-CN" | "en";
    selection?: {
      start: number;
      end: number;
      before: string;
      after: string;
    };
  };
  tableCell?: {
    address: string;
    row: number;
    column: number;
    before: string;
    after: string;
  };
};

export type Comment = {
  id: string;
  blockId: string;
  text: string;
  severity: string;
  source: string;
};

export type SessionReviewThread = {
  id: string;
  documentId?: string;
  anchor: {
    blockId: string;
    blockIds?: string[];
    selectionText: string;
    selectionStart?: number;
    tableCell?: {
      row: number;
      column: number;
      address: string;
      before: string;
    };
    crossTableCells?: boolean;
  };
  collapsed: boolean;
  createdAt: string;
};

function tokenFromLocation(): string | null {
  const hash = new URL(location.href).hash.replace(/^#token=/, "");
  if (hash) {
    localStorage.setItem("margin_token", hash);
    return hash;
  }
  return localStorage.getItem("margin_token");
}

export const token = tokenFromLocation();

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const failure = data as { error?: string; reason?: string };
    throw new Error(failure.error || failure.reason || r.statusText);
  }
  return data as T;
}

export async function openDocument(relativePath: string) {
  return api<{ document: DocumentMeta; blocks: Block[] }>("/api/v1/documents/open", {
    method: "POST",
    body: JSON.stringify({ relativePath }),
  });
}

export async function listFiles() {
  return api<{ files: string[] }>("/api/v1/workspace/files");
}

export async function saveSessionSources(sourcePaths: string[]) {
  return api<{ sourcePaths: string[] }>("/api/v1/session/sources", {
    method: "PUT",
    body: JSON.stringify({ sourcePaths }),
  });
}

export async function saveSessionThreads(documentId: string, threads: SessionReviewThread[]) {
  return api<{ threads: SessionReviewThread[] }>("/api/v1/session/threads", {
    method: "PUT",
    body: JSON.stringify({ documentId, threads }),
  });
}

export async function readSourceChunk(sourceRef: string) {
  return api<{
    sourceRef: string;
    relativePath: string;
    excerpt: string;
    selectionStart: number;
    selectionEnd: number;
  }>("/api/v1/workspace/source-chunk", {
    method: "POST",
    body: JSON.stringify({ sourceRef }),
  });
}

export type SkillSummary = {
  name: string;
  description: string;
  contentHash: string;
  source: "bundled" | "workspace";
};

export type AgentTask = {
  objective: string;
  status: "running" | "completed" | "interrupted";
  currentStep?: string;
  sourcePaths: string[];
  sourceRefs: string[];
  proposalCount: number;
  inspectedDocument: boolean;
  consistencyChecked: boolean;
  selection?: {
    blockIds: string[];
    text?: string;
    start?: number;
  };
  updatedAt: string;
};

export async function listSkills() {
  return api<{ skills: SkillSummary[] }>("/api/v1/extensions/skills");
}

export async function importSkill(content: string) {
  return api<{ ok: true; skill: SkillSummary }>("/api/v1/extensions/skills", {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

export async function removeSkill(name: string) {
  return api<{ ok: true }>(`/api/v1/extensions/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export type McpToolSummary = {
  name: string;
  description: string;
  readOnly?: boolean;
};

export type McpServerSummary = {
  id: string;
  name: string;
  url: string;
  tokenSet: boolean;
  enabledTools: McpToolSummary[];
};

export async function listMcpServers() {
  return api<{ servers: McpServerSummary[] }>("/api/v1/extensions/mcp");
}

export async function discoverMcp(url: string, tokenValue?: string, serverId?: string) {
  return api<{ url: string; tools: McpToolSummary[]; latencyMs: number }>(
    "/api/v1/extensions/mcp/discover",
    {
      method: "POST",
      body: JSON.stringify({
        url,
        token: tokenValue || undefined,
        serverId: serverId || undefined,
      }),
    },
  );
}

export async function saveMcpServer(input: {
  name?: string;
  url: string;
  token?: string;
  clearToken?: boolean;
  enabledTools: string[];
}) {
  return api<{ ok: true; server: McpServerSummary }>("/api/v1/extensions/mcp", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function removeMcpServer(id: string) {
  return api<{ ok: true }>(`/api/v1/extensions/mcp/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function listProposals(documentId: string) {
  return api<{ proposals: Proposal[] }>(
    `/api/v1/documents/${documentId}/proposals?status=proposed`,
  );
}

export async function listComments(documentId: string) {
  return api<{ comments: Comment[]; citeDisclaimer?: string }>(
    `/api/v1/documents/${documentId}/comments`,
  );
}

export type TimelineEntry = {
  id: string;
  createdAt: string;
  ok: boolean;
  reason: string | null;
  proposalId: string;
  decisionId: string;
  blockId: string | null;
  rationale: string | null;
  risk: string | null;
  decisionKind: string | null;
  operationKind: string | null;
  beforeText: string | null;
  afterText: string | null;
  beforeRevision: number;
  afterRevision: number | null;
};

export async function listDocumentTimeline(documentId: string, limit = 40) {
  return api<{ entries: TimelineEntry[] }>(
    `/api/v1/documents/${documentId}/timeline?limit=${limit}`,
  );
}

export type LlmProviderPublic = {
  id: string;
  name: string;
  apiFormat: "openai" | "anthropic";
  baseURL: string;
  model: string;
  authStyle: "bearer" | "apikey";
  apiKeySet: boolean;
  apiKeyHint: string;
  source?: string;
  websiteUrl?: string;
  currentInCcSwitch?: boolean;
};

export type LlmSettingsPublic = {
  activeId: string;
  provider: LlmProviderPublic | null;
  providers: LlmProviderPublic[];
  presets: Array<{
    id: string;
    name: string;
    apiFormat: "openai" | "anthropic";
    baseURL: string;
    model: string;
    authStyle: "bearer" | "apikey";
    hint?: string;
    websiteUrl?: string;
  }>;
  llmMode: "mock" | "byok";
  harnessId?: string;
  ccSwitch?: {
    detected: boolean;
    proxyBaseURL?: string;
    proxyEnabled?: boolean;
  };
  imported?: number;
  source?: string;
  /** @deprecated flattened fields for older UI */
  apiKeySet?: boolean;
};

export async function getLlmSettings() {
  return api<LlmSettingsPublic>("/api/v1/settings/llm");
}

export async function saveLlmSettings(body: {
  clearApiKey?: boolean;
  provider?:
    | "openai"
    | "anthropic"
    | {
        id?: string;
        name?: string;
        apiFormat?: "openai" | "anthropic";
        model?: string;
        apiKey?: string;
        baseURL?: string;
        authStyle?: "bearer" | "apikey";
      };
  model?: string;
  apiKey?: string;
  baseURL?: string;
  authStyle?: "bearer" | "apikey";
  harnessId?: string | null;
}) {
  return api<LlmSettingsPublic>("/api/v1/settings/llm", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export type HarnessSummary = {
  id: string;
  title: string;
};

export async function listHarnesses() {
  return api<{ harnesses: HarnessSummary[]; defaultId: string }>("/api/v1/harnesses");
}

export type LlmConnectionDraft = {
  apiFormat: "openai" | "anthropic";
  authStyle: "bearer" | "apikey";
  baseURL: string;
  apiKey?: string;
  model?: string;
  reuseStoredKey?: boolean;
};

export type LlmProbeResult = {
  ok: boolean;
  latencyMs: number;
  detail: string;
  resolvedBaseURL?: string;
};

export type LlmModelDiscoveryResult = LlmProbeResult & {
  models: string[];
};

export async function discoverLlmModels(draft: LlmConnectionDraft) {
  return api<LlmModelDiscoveryResult>("/api/v1/settings/llm/models", {
    method: "POST",
    body: JSON.stringify(draft),
  });
}

export async function closeDocumentSession() {
  return api<{ ok: true; closedDocumentId?: string }>("/api/v1/session/document", {
    method: "DELETE",
  });
}

export function isNativeDocx(document: Pick<DocumentMeta, "relativePath">): boolean {
  return /\.docx$/i.test(document.relativePath);
}

export async function fetchNativeDocx(documentId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(`/api/v1/documents/${documentId}/native-docx`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || response.statusText);
  }
  return response.arrayBuffer();
}

export class NativeDocxRebuildRequiredError extends Error {}

export async function saveNativeDocx(
  document: DocumentMeta,
  content: ArrayBuffer,
  saveMode: "preserve" | "rebuild" = "preserve",
  changedBlockIds: string[] = [],
) {
  const response = await fetch(`/api/v1/documents/${document.id}/native-docx`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "X-Margin-Revision": String(document.revision),
      "X-Margin-Hash": document.contentHash,
      "X-Margin-Save-Mode": saveMode,
      ...(changedBlockIds.length ? { "X-Margin-Changed-Blocks": changedBlockIds.join(",") } : {}),
    },
    body: content,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if ((data as { reason?: string }).reason === "rebuild_required") {
      const detail = (data as { detail?: string }).detail;
      throw new NativeDocxRebuildRequiredError(detail ? `该修改需要重建 DOCX：${detail}` : "该修改需要重建 DOCX");
    }
    throw new Error((data as { error?: string }).error || response.statusText);
  }
  return data as {
    ok: true;
    document: DocumentMeta;
    blocks: Block[];
    saveMode: "ooxml_patch" | "rebuilt";
  };
}

export async function testLlmConnection(draft: LlmConnectionDraft) {
  return api<LlmProbeResult>(
    "/api/v1/settings/llm/test",
    { method: "POST", body: JSON.stringify(draft) },
  );
}

export async function startProposalRun(
  documentId: string,
  blockIds: string[],
  opts?: {
    harnessId?: string;
    instruction?: string;
    selectionText?: string;
    selectionStart?: number;
    operation?: "rewrite" | "translate" | "polish";
    targetLanguage?: "zh-CN" | "en";
    tableCell?: {
      row: number;
      column: number;
      address: string;
      before: string;
    };
    sourcePaths?: string[];
    preferSimple?: boolean;
  },
) {
  return api<{ runId: string }>(`/api/v1/documents/${documentId}/proposal-runs`, {
    method: "POST",
    body: JSON.stringify({
      blockIds,
      harnessId: opts?.harnessId,
      instruction: opts?.instruction,
      selectionText: opts?.selectionText,
      selectionStart: opts?.selectionStart,
      operation: opts?.operation,
      targetLanguage: opts?.targetLanguage,
      tableCell: opts?.tableCell,
      sourcePaths: opts?.sourcePaths,
      preferSimple: opts?.preferSimple ?? false,
    }),
  });
}

export async function waitRun(
  runId: string,
  maxMs = 130_000,
  onTick?: (info: {
    elapsedMs: number;
    status: string;
    phase?: string;
    steps?: string[];
  }) => void,
  signal?: AbortSignal,
) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const run = await api<{
      status: string;
      error?: string;
      engine?: string;
      fallbackFrom?: string;
      fallbackReason?: string;
      notes?: string[];
      commentCount?: number;
      citeDisclaimer?: string;
      phase?: string;
      steps?: string[];
      proposalIds?: string[];
    }>(`/api/v1/proposal-runs/${runId}`);
    onTick?.({
      elapsedMs: Date.now() - start,
      status: run.status,
      phase: run.phase,
      steps: run.steps,
    });
    if (run.status === "done") return run;
    if (run.status === "error") throw new Error(run.error || "run failed");
    if (run.status === "superseded") {
      throw new Error(run.phase || "提案任务已被较新的任务替代");
    }
    if (run.status === "cancelled") throw new DOMException("Aborted", "AbortError");
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timer = window.setTimeout(finish, 500);
      const abort = () => {
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  throw new Error("proposal run timeout");
}

export async function cancelProposalRun(runId: string) {
  return api<{ ok: true; status: string }>(`/api/v1/proposal-runs/${runId}`, {
    method: "DELETE",
  });
}

export async function exportDocumentDocx(documentId: string) {
  return api<{ relativePath: string; report?: { ok: boolean; flags?: string[]; ratios?: { chars: number; headings: number } } }>(
    `/api/v1/documents/${documentId}/export-docx`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function decide(
  proposalId: string,
  kind: "Y" | "N" | "E",
  editedText?: string,
) {
  return api(`/api/v1/proposals/${proposalId}/decision`, {
    method: "PATCH",
    body: JSON.stringify({ kind, editedText }),
  });
}

export async function resolveProposal(
  doc: DocumentMeta,
  proposalId: string,
  kind: "Y" | "N" | "E",
  editedText?: string,
) {
  return api<{
    ok: boolean;
    rejected?: boolean;
    document?: DocumentMeta;
    blocks?: Block[];
    reason?: string;
  }>(`/api/v1/proposals/${proposalId}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      kind,
      editedText,
      expectedRevision: doc.revision,
      expectedHash: doc.contentHash,
      documentId: doc.id,
    }),
  });
}

export async function chatTurn(body: {
  message: string;
  documentId?: string;
  selectionBlockIds?: string[];
  selectionText?: string;
  selectionStart?: number;
  sourcePaths?: string[];
}) {
  return api<{
    reply: string;
    closed?: boolean;
    runId?: string;
    sourcePaths?: string[];
    opened?: { document: DocumentMeta; blocks: Block[] };
    run?: {
      engine?: string;
      fallbackFrom?: string;
      notes?: string[];
      citeDisclaimer?: string;
    };
  }>("/api/v1/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type ChatStreamEvent =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "run"; runId: string }
  | {
      type: "done";
      reply: string;
      runId?: string;
      opened?: { document: DocumentMeta; blocks: Block[] };
      engine?: string;
      steps?: string[];
      proposalCount?: number;
      clarificationRounds?: number;
      sourcePaths?: string[];
      closed?: boolean;
      cascadeOffer?: Array<{ blockId: string; reason: string; query?: string }>;
      task?: AgentTask;
    }
  | { type: "error"; error: string };

/** NDJSON chat stream with status/delta/done. */
export async function chatStream(
  body: {
    message: string;
    documentId?: string;
    selectionBlockIds?: string[];
    selectionText?: string;
    selectionStart?: number;
    chatMode?: "direct" | "socratic";
    cascadeBlockIds?: string[];
    sourcePaths?: string[];
    threadId?: string;
    harnessId?: string;
  },
  onEvent: (ev: ChatStreamEvent) => void,
  signal?: AbortSignal,
) {
  const r = await fetch("/api/v1/chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok || !r.body) {
    const data = await r.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || r.statusText);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastDone: Extract<ChatStreamEvent, { type: "done" }> | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const ev = JSON.parse(t) as ChatStreamEvent;
      onEvent(ev);
      if (ev.type === "done") lastDone = ev;
      if (ev.type === "error") throw new Error(ev.error);
    }
  }
  if (buf.trim()) {
    const ev = JSON.parse(buf.trim()) as ChatStreamEvent;
    onEvent(ev);
    if (ev.type === "done") lastDone = ev;
    if (ev.type === "error") throw new Error(ev.error);
  }
  if (!lastDone) throw new Error("chat stream ended without done");
  return lastDone;
}

/** Strip leading markdown heading markers for display. */
export function displayText(block: Block): string {
  if (block.kind === "heading") {
    return block.text.replace(/^#{1,6}\s+/, "");
  }
  if (block.kind === "blockquote") {
    return block.text
      .split("\n")
      .map((l) => l.replace(/^>\s?/, ""))
      .join("\n");
  }
  return block.text;
}
