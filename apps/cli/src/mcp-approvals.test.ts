import { describe, expect, it } from "vitest";
import { createRemoteMcpTools, type RemoteMcpBridge } from "@margin/agent";
import { createMcpApprovalRegistry, type McpApprovalRequestInput } from "./mcp-approvals.js";

const baseInput: McpApprovalRequestInput = {
  workspaceRoot: "/ws",
  sessionId: "sess-1",
  runId: "run-1",
  toolCallId: "tc-1",
  serverId: "mcp-aaaaaaaaaaaa",
  serverName: "Archive",
  tool: "lookup",
  args: { q: "evidence" },
};

describe("MCP approval registry", () => {
  it("allow resolves once with bounded redacted audit; replay of the id fails", async () => {
    const registry = createMcpApprovalRegistry();
    const { approvalId, wait } = registry.request(baseInput);
    const resolved = registry.resolve(approvalId, "allow");
    expect(resolved.status).toBe("ok");
    const { outcome, audit } = await wait;
    expect(outcome.decision).toBe("allow");
    expect(audit).toMatchObject({
      approvalId,
      sessionId: "sess-1",
      runId: "run-1",
      toolCallId: "tc-1",
      serverId: "mcp-aaaaaaaaaaaa",
      tool: "lookup",
      decision: "allow",
    });
    expect(audit.argsHash).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(audit)).not.toContain("evidence");
    // One-use: cross-run replay / double resolution of the same id fails.
    expect(registry.resolve(approvalId, "allow").status).toBe("unknown");
    expect(registry.resolve(approvalId, "deny").status).toBe("unknown");
  });

  it("deny resolves with decision deny", async () => {
    const registry = createMcpApprovalRegistry();
    const { approvalId, wait } = registry.request(baseInput);
    expect(registry.resolve(approvalId, "deny").status).toBe("ok");
    const { outcome } = await wait;
    expect(outcome.decision).toBe("deny");
  });

  it("expires after the TTL and answers expired on late decisions", async () => {
    const registry = createMcpApprovalRegistry({ expiryMs: 20 });
    const { approvalId, wait } = registry.request(baseInput);
    const { outcome, audit } = await wait;
    expect(outcome.decision).toBe("deny");
    expect(outcome.reason).toBe("expired");
    expect(audit.decision).toBe("deny");
    expect(registry.resolve(approvalId, "allow").status).toBe("expired");
  });

  it("denyAllForRun denies only that run (cancel / disconnect path)", async () => {
    const registry = createMcpApprovalRegistry();
    const runA = registry.request({ ...baseInput, runId: "run-A", toolCallId: "tc-A" });
    const runB = registry.request({ ...baseInput, runId: "run-B", toolCallId: "tc-B" });
    const denied = registry.denyAllForRun("run-A", "run-cancelled");
    expect(denied).toHaveLength(1);
    expect((await runA.wait).outcome).toMatchObject({ decision: "deny", reason: "run-cancelled" });
    // The other run's approval is still usable.
    expect(registry.resolve(runB.approvalId, "allow").status).toBe("ok");
    expect((await runB.wait).outcome.decision).toBe("allow");
  });

  it("denyAllForSession denies pending approvals of a superseded session", async () => {
    const registry = createMcpApprovalRegistry();
    const old = registry.request({ ...baseInput, sessionId: "sess-old" });
    const current = registry.request({ ...baseInput, sessionId: "sess-new", toolCallId: "tc-2" });
    registry.denyAllForSession("sess-old", "superseded");
    expect((await old.wait).outcome).toMatchObject({ decision: "deny", reason: "superseded" });
    expect(registry.resolve(current.approvalId, "allow").status).toBe("ok");
    await current.wait;
  });
  it("rememberForSession auto-allows later calls of the same server+tool", async () => {
    const registry = createMcpApprovalRegistry();
    const first = registry.request(baseInput);
    expect(registry.resolve(first.approvalId, "allow", { rememberForSession: true }).status)
      .toBe("ok");
    await first.wait;
    expect(registry.isTrusted("sess-1", "mcp-aaaaaaaaaaaa", "lookup")).toBe(true);

    // Later run in the same session skips the UI when Host checks isTrusted.
    expect(registry.isTrusted("sess-1", "mcp-aaaaaaaaaaaa", "other")).toBe(false);
    expect(registry.isTrusted("sess-2", "mcp-aaaaaaaaaaaa", "lookup")).toBe(false);
  });

  it("session-switch clears trust; mid-session supersede does not", () => {
    const registry = createMcpApprovalRegistry();
    const first = registry.request(baseInput);
    expect(registry.resolve(first.approvalId, "allow", { rememberForSession: true }).status)
      .toBe("ok");
    registry.denyAllForSession("sess-1", "superseded");
    expect(registry.isTrusted("sess-1", "mcp-aaaaaaaaaaaa", "lookup")).toBe(true);
    registry.denyAllForSession("sess-1", "session-switch");
    expect(registry.isTrusted("sess-1", "mcp-aaaaaaaaaaaa", "lookup")).toBe(false);
  });
});

describe("approval gate × registry: remote call counts", () => {
  function wiredRun(registryOptions?: { expiryMs?: number }) {
    const registry = createMcpApprovalRegistry(registryOptions);
    const counters = { calls: 0 };
    const requested: string[] = [];
    const bridge: RemoteMcpBridge = {
      listCallableTools: () => [{
        serverId: baseInput.serverId,
        serverName: baseInput.serverName,
        tool: baseInput.tool,
        description: "Read evidence",
        schema: { type: "object" },
      }],
      callTool: async () => {
        counters.calls += 1;
        return { content: "evidence-result", truncated: false };
      },
    };
    const [tool] = createRemoteMcpTools({
      bridge,
      requestApproval: async (request) => {
        const { approvalId, wait } = registry.request({
          ...baseInput,
          toolCallId: request.toolCallId,
          args: request.args,
        });
        requested.push(approvalId);
        const { outcome } = await wait;
        return outcome.decision;
      },
    });
    return { registry, counters, requested, tool: tool! };
  }

  function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content[0] && "text" in result.content[0]
      ? String(result.content[0].text)
      : "";
  }

  it("allow makes EXACTLY ONE remote call", async () => {
    const run = wiredRun();
    const executing = run.tool.execute("tc-1", {} as never);
    await new Promise((resolve) => setImmediate(resolve));
    expect(run.requested).toHaveLength(1);
    expect(run.registry.resolve(run.requested[0]!, "allow").status).toBe("ok");
    const result = await executing;
    expect(run.counters.calls).toBe(1);
    expect(resultText(result as never)).toContain("evidence-result");
  });

  it("deny makes ZERO remote calls", async () => {
    const run = wiredRun();
    const executing = run.tool.execute("tc-1", {} as never);
    await new Promise((resolve) => setImmediate(resolve));
    expect(run.registry.resolve(run.requested[0]!, "deny").status).toBe("ok");
    const result = await executing;
    expect(run.counters.calls).toBe(0);
    expect(resultText(result as never)).toContain("未发起任何网络请求");
  });

  it("60s expiry (timeout) makes ZERO remote calls", async () => {
    const run = wiredRun({ expiryMs: 20 });
    const result = await run.tool.execute("tc-1", {} as never);
    expect(run.counters.calls).toBe(0);
    expect(resultText(result as never)).toContain("未批准");
  });

  it("cancellation (denyAllForRun) makes ZERO remote calls", async () => {
    const run = wiredRun();
    const executing = run.tool.execute("tc-1", {} as never);
    await new Promise((resolve) => setImmediate(resolve));
    run.registry.denyAllForRun("run-1", "run-cancelled");
    const result = await executing;
    expect(run.counters.calls).toBe(0);
    expect(resultText(result as never)).toContain("未批准");
  });

  it("disconnect of a superseded session (denyAllForSession) makes ZERO remote calls", async () => {
    const run = wiredRun();
    const executing = run.tool.execute("tc-1", {} as never);
    await new Promise((resolve) => setImmediate(resolve));
    run.registry.denyAllForSession("sess-1", "superseded");
    const result = await executing;
    expect(run.counters.calls).toBe(0);
  });

  it("cross-run replay of an approval id fails and cannot trigger a call", async () => {
    const runA = wiredRun();
    const execA = runA.tool.execute("tc-A", {} as never);
    await new Promise((resolve) => setImmediate(resolve));
    const approvalId = runA.requested[0]!;
    expect(runA.registry.resolve(approvalId, "allow").status).toBe("ok");
    await execA;
    expect(runA.counters.calls).toBe(1);
    // A later run replaying the consumed id is rejected; no new call happens.
    const runB = wiredRun();
    expect(runB.registry.resolve(approvalId, "allow").status).toBe("unknown");
    expect(runB.counters.calls).toBe(0);
  });
});
