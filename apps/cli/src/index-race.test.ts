import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listBlocks, openDocument, saveProposal } from "@margin/storage-local";

/**
 * I1 regression: proposal decision / apply / resolve routes mutate the shared
 * chat agent state, so they must run on the same serialized queue as chat
 * turns. While a chat turn is in flight (queue occupied), a decision request
 * must wait instead of interleaving its note/persist with the turn.
 *
 * Boots the real server in-process (offline mock LLM) via the runtime seam.
 */
describe("chat queue serialization (I1)", () => {
  const dirs: string[] = [];
  const ENV_KEYS = ["MARGIN_PORT", "MARGIN_NO_OPEN"];
  let savedEnv: Record<string, string | undefined> = {};
  let savedArgv: string[] = [];

  afterEach(async () => {
    const { runtime } = await import("./index.js");
    if (runtime.app) {
      try {
        await runtime.app.close();
      } catch {
        /* ignore */
      }
      runtime.app = undefined;
    }
    if (runtime.state) {
      try {
        runtime.state.workspace.db.close();
      } catch {
        /* ignore */
      }
      try {
        await runtime.state.workspace.releaseLock();
      } catch {
        /* ignore */
      }
      runtime.state = undefined;
    }
    runtime.enqueueChat = undefined;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    process.argv = savedArgv;
    for (const dir of dirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("serializes PATCH /proposals/:id/decision behind an in-flight chat turn", async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    savedArgv = process.argv;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-index-race-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "paper.md"), "# 标题\n\n第一段。\n", "utf8");
    process.argv = ["node", "margin-agent", root];
    process.env.MARGIN_PORT = "0";
    process.env.MARGIN_NO_OPEN = "1";

    await import("./index.js");
    const { runtime } = await import("./index.js");
    // main() runs async from module load; wait for the listen seam.
    for (let attempt = 0; attempt < 200 && !runtime.app; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!runtime.app || !runtime.state || !runtime.enqueueChat) {
      throw new Error("server did not boot");
    }
    const { app, state, enqueueChat } = runtime as {
      app: NonNullable<typeof runtime.app>;
      state: NonNullable<typeof runtime.state>;
      enqueueChat: NonNullable<typeof runtime.enqueueChat>;
    };

    // Seed a document + proposed proposal the decision route can act on.
    const workspace = state.workspace;
    const document = openDocument(workspace, "paper.md");
    const blocks = listBlocks(workspace, document.id);
    saveProposal(workspace, {
      schemaVersion: 1,
      id: "proposal-race",
      documentId: document.id,
      blockId: blocks[0]!.id,
      baseRevision: document.revision,
      baseHash: blocks[0]!.contentHash,
      before: blocks[0]!.text,
      after: `${blocks[0]!.text}改`,
      rationale: "race test",
      risk: "language",
      evidence: [],
      status: "proposed",
      createdAt: new Date().toISOString(),
    });

    // Occupy the chat queue the way an in-flight chat turn does.
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const inFlightTurn = enqueueChat(() => turnGate);

    const pendingDecision = app.inject({
      method: "PATCH",
      url: "/api/v1/proposals/proposal-race/decision",
      headers: { authorization: `Bearer ${state.token}` },
      payload: { kind: "N" },
    });

    // While the turn holds the queue, the decision must NOT complete.
    const respondedEarly = await Promise.race([
      pendingDecision.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    expect(respondedEarly).toBe(false);

    releaseTurn();
    await inFlightTurn;
    const response = await pendingDecision;
    expect(response.statusCode).toBe(200);
    expect(response.json().decision.kind).toBe("N");
  }, 30_000);
});
