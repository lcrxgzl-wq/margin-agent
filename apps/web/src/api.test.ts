import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("waitRun", () => {
  it("stops polling when the backend reports a superseded run", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("location", { href: "http://127.0.0.1/#token=test-token" });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      statusText: "",
      json: async () => ({ status: "superseded", phase: "已被较新的任务替代" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { waitRun } = await import("./api");

    await expect(waitRun("old-run", 1_000)).rejects.toThrow("已被较新的任务替代");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps polling without a frontend deadline when maxMs is omitted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const values = new Map<string, string>();
    vi.stubGlobal("location", { href: "http://127.0.0.1/#token=test-token" });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        statusText: "",
        json: async () => ({ status: "running", phase: "生成中" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        statusText: "",
        json: async () => ({ status: "done", proposalIds: ["p1"] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const { waitRun } = await import("./api");

    const pending = waitRun("long-run");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(200_000);
    await vi.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toMatchObject({ status: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("compactSession", () => {
  it("posts to /api/v1/sessions/compact and returns token counts", async () => {
    vi.stubGlobal("location", { href: "http://127.0.0.1/#token=test-token" });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      statusText: "",
      json: async () => ({ tokensBefore: 90_000, tokensAfter: 20_000, summary: "摘要" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { compactSession } = await import("./api");

    const result = await compactSession();
    expect(result).toEqual({ tokensBefore: 90_000, tokensAfter: 20_000, summary: "摘要" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/sessions/compact");
    expect(init.method).toBe("POST");
  });
});

describe("saveLlmSettings", () => {
  it("sends custom timeout and selection context settings", async () => {
    vi.stubGlobal("location", { href: "http://127.0.0.1/#token=test-token" });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      statusText: "",
      json: async () => ({ activeId: "custom", providers: [], presets: [], llmMode: "mock" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { saveLlmSettings } = await import("./api");
    await saveLlmSettings({
      agentTimeoutMs: 1_200_000,
      selectionContextChars: 64_000,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/settings/llm");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toMatchObject({
      agentTimeoutMs: 1_200_000,
      selectionContextChars: 64_000,
    });
  });
});

describe("resolveProposals", () => {
  it("sends one atomic batch request with the document preconditions", async () => {
    vi.stubGlobal("location", { href: "http://127.0.0.1/#token=test-token" });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      statusText: "",
      json: async () => ({
        ok: true,
        document: { id: "doc-1", relativePath: "paper.md", revision: 4, contentHash: "fedcba9876543210" },
        blocks: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { resolveProposals } = await import("./api");
    await resolveProposals(
      { id: "doc-1", relativePath: "paper.md", revision: 3, contentHash: "0123456789abcdef" },
      ["proposal-1", "proposal-2"],
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/documents/doc-1/resolve-proposals");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      proposalIds: ["proposal-1", "proposal-2"],
      expectedRevision: 3,
      expectedHash: "0123456789abcdef",
    });
  });
});

describe("review checklist requests", () => {
  it("loads active runs and posts one batch decision", async () => {
    vi.stubGlobal("location", { href: "http://127.0.0.1/#token=test-token" });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
    });
    const run = {
      run: {
        schemaVersion: 1,
        id: "run-1",
        documentId: "doc-1",
        checker: "cite_check",
        disclaimer: "形态检查边界",
        status: "active",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      items: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        statusText: "",
        json: async () => ({ runs: [run] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        statusText: "",
        json: async () => ({
          decision: {
            schemaVersion: 1,
            id: "decision-1",
            runId: "run-1",
            itemIds: ["item-1", "item-2"],
            kind: "resolve",
            createdAt: "2026-08-01T00:01:00.000Z",
          },
          run,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { decideReviewChecklist, listReviewChecklists } = await import("./api");
    await expect(listReviewChecklists("doc-1")).resolves.toEqual({ runs: [run] });
    await decideReviewChecklist("run-1", ["item-1", "item-2"], "resolve");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/documents/doc-1/checklists");
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/v1/checklists/run-1/decisions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      itemIds: ["item-1", "item-2"],
      kind: "resolve",
    });
  });
});

describe("document-scoped session requests", () => {
  it("sends explicit document identity for sources and DOCX imports", async () => {
    vi.stubGlobal("location", { href: "http://127.0.0.1/#token=test-token" });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      statusText: "",
      json: async () => ({ sourcePaths: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { importWorkspaceDocx, openDocument, saveSessionSources } = await import("./api");
    await saveSessionSources("doc-1", ["sources/notes.md"]);
    await saveSessionSources(null, []);
    await importWorkspaceDocx("imports/paper.docx", { id: "doc-1", revision: 4 });
    await importWorkspaceDocx("imports/paper.docx", null);
    await openDocument("paper.md", { id: "doc-1", revision: 4 });
    await openDocument("paper.md");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/session/sources",
      "/api/v1/session/sources",
      "/api/v1/documents/import-docx",
      "/api/v1/documents/import-docx",
      "/api/v1/documents/open",
      "/api/v1/documents/open",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body))))
      .toEqual([
        { documentId: "doc-1", sourcePaths: ["sources/notes.md"] },
        { documentId: null, sourcePaths: [] },
        {
          relativePath: "imports/paper.docx",
          expectedDocument: { id: "doc-1", revision: 4 },
        },
        { relativePath: "imports/paper.docx", expectedDocument: null },
        {
          relativePath: "paper.md",
          expectedDocument: { id: "doc-1", revision: 4 },
        },
        { relativePath: "paper.md" },
      ]);
  });
});
