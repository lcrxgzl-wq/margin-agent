import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  latestAgentCompactionSummary,
  listAgentCompactions,
  openWorkspace,
  saveAgentCompaction,
} from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-compactions-"));
  dirs.push(root);
  fs.writeFileSync(path.join(root, "a.md"), "# hi\n", "utf8");
  return openWorkspace(root);
}

describe("agent_compactions archive", () => {
  it("saves a compaction and reads metadata + latest summary back", async () => {
    const ws = await tempWorkspace();
    const saved = saveAgentCompaction(ws, {
      sessionId: "sess-1",
      eventId: "evt-1",
      reason: "threshold",
      tokensBefore: 90_000,
      tokensAfter: 21_000,
      summary: "摘要一",
      previousSummary: undefined,
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ],
    });
    expect(saved.duplicate).toBe(false);
    expect(saved.id).toBeTruthy();

    const rows = listAgentCompactions(ws, "sess-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "sess-1",
      reason: "threshold",
      tokensBefore: 90_000,
      tokensAfter: 21_000,
      summary: "摘要一",
      messageCount: 2,
      truncated: false,
      truncatedCount: 0,
    });
    expect(latestAgentCompactionSummary(ws, "sess-1")).toBe("摘要一");
    expect(latestAgentCompactionSummary(ws, "other-session")).toBeUndefined();
  });

  it("dedupes by event_id; the same summary under a new event archives again", async () => {
    const ws = await tempWorkspace();
    const input = {
      sessionId: "sess-1",
      reason: "overflow",
      tokensBefore: 120_000,
      tokensAfter: 30_000,
      summary: "同一份摘要",
      messages: [{ role: "user", content: "u1" }],
    };
    const first = saveAgentCompaction(ws, { ...input, eventId: "evt-a" });
    const second = saveAgentCompaction(ws, { ...input, eventId: "evt-a" });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    // I3: a fresh compaction event must never be mistaken for a duplicate,
    // even when summary + tokensBefore happen to be identical.
    const third = saveAgentCompaction(ws, { ...input, eventId: "evt-b" });
    expect(third.duplicate).toBe(false);
    expect(third.id).not.toBe(first.id);
    expect(listAgentCompactions(ws, "sess-1")).toHaveLength(2);
  });

  it("keeps the newest summary as previousSummary source", async () => {
    const ws = await tempWorkspace();
    saveAgentCompaction(ws, {
      sessionId: "sess-1",
      eventId: "evt-old",
      reason: "threshold",
      tokensBefore: 90_000,
      tokensAfter: 20_000,
      summary: "旧摘要",
      messages: [],
    });
    saveAgentCompaction(ws, {
      sessionId: "sess-1",
      eventId: "evt-new",
      reason: "manual",
      tokensBefore: 80_000,
      tokensAfter: 18_000,
      summary: "新摘要",
      previousSummary: "旧摘要",
      messages: [],
    });
    expect(latestAgentCompactionSummary(ws, "sess-1")).toBe("新摘要");
    const rows = listAgentCompactions(ws, "sess-1");
    expect(rows.map((row) => row.summary)).toEqual(["新摘要", "旧摘要"]);
    expect(rows[0]?.previousSummary).toBe("旧摘要");
  });

  it("truncates the archived transcript to the byte cap, keeping the original count", async () => {
    const ws = await tempWorkspace();
    const big = { role: "user", content: "x".repeat(100_000) };
    const messages = Array.from({ length: 20 }, () => big);
    const saved = saveAgentCompaction(ws, {
      sessionId: "sess-1",
      eventId: "evt-trunc",
      reason: "threshold",
      tokensBefore: 500_000,
      tokensAfter: 20_000,
      summary: "摘要",
      messages,
    });
    expect(saved.archivedBytes).toBeLessThanOrEqual(800_000);
    const rows = listAgentCompactions(ws, "sess-1");
    expect(rows[0]?.truncated).toBe(true);
    // I4: message_count is the original transcript size; truncated_count the dropped prefix.
    expect(rows[0]?.messageCount).toBe(20);
    expect(rows[0]?.truncatedCount).toBeGreaterThan(0);
    expect(rows[0]?.truncatedCount).toBeLessThan(20);
  });

  it("drops the oldest messages only at user-message boundaries (I4)", async () => {
    const ws = await tempWorkspace();
    const big = "x".repeat(100_000);
    // Naive head-slicing would leave an orphan assistant/toolResult at the head.
    const messages = Array.from({ length: 9 }, (_, index) => [
      { role: "user", content: `u${index}-${big}` },
      { role: "assistant", content: [{ type: "text", text: big }] },
      { role: "toolResult", toolCallId: `c${index}`, content: [{ type: "text", text: big }] },
    ]).flat();
    const saved = saveAgentCompaction(ws, {
      sessionId: "sess-1",
      eventId: "evt-boundary",
      reason: "threshold",
      tokensBefore: 900_000,
      tokensAfter: 20_000,
      summary: "摘要",
      messages,
    });
    const row = ws.db
      .prepare("SELECT messages_json FROM agent_compactions WHERE id = ?")
      .get(saved.id) as { messages_json: string };
    const kept = JSON.parse(row.messages_json) as Array<{ role: string }>;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[0]!.role).toBe("user");
  });

  it("migrates a legacy agent_compactions table (adds event_id + truncated_count)", async () => {
    const ws = await tempWorkspace();
    ws.db.exec(`
      CREATE TABLE agent_compactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        tokens_before INTEGER NOT NULL,
        tokens_after INTEGER NOT NULL,
        summary TEXT NOT NULL,
        previous_summary TEXT,
        message_count INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        messages_json TEXT NOT NULL
      );
      INSERT INTO agent_compactions (
        id, session_id, created_at, reason, tokens_before, tokens_after,
        summary, previous_summary, message_count, truncated, messages_json
      ) VALUES ('legacy-1', 'sess-1', '2026-07-01T00:00:00.000Z', 'threshold',
                90000, 20000, '旧存档', NULL, 2, 0, '[]');
    `);
    const saved = saveAgentCompaction(ws, {
      sessionId: "sess-1",
      eventId: "evt-migrated",
      reason: "manual",
      tokensBefore: 80_000,
      tokensAfter: 18_000,
      summary: "新存档",
      messages: [],
    });
    expect(saved.duplicate).toBe(false);
    const rows = listAgentCompactions(ws, "sess-1");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.summary)).toEqual(["新存档", "旧存档"]);
    expect(rows[1]?.truncatedCount).toBe(0);
  });

  it("prunes the archive to the newest 50 rows", async () => {
    const ws = await tempWorkspace();
    for (let index = 0; index < 55; index += 1) {
      saveAgentCompaction(ws, {
        sessionId: "sess-1",
        eventId: `evt-${index}`,
        reason: "threshold",
        tokensBefore: 90_000 + index,
        tokensAfter: 20_000,
        summary: `摘要-${index}`,
        messages: [],
      });
    }
    const rows = listAgentCompactions(ws, "sess-1");
    expect(rows).toHaveLength(50);
    expect(rows[0]?.summary).toBe("摘要-54");
    expect(rows.at(-1)?.summary).toBe("摘要-5");
  });
});
