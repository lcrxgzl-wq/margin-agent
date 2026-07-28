import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listModelUsage,
  openWorkspace,
  recordModelUsage,
  type Workspace,
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

async function withWorkspace(fn: (ws: Workspace) => void): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-usage-"));
  dirs.push(root);
  const ws = await openWorkspace(root);
  try {
    fn(ws);
  } finally {
    try {
      ws.db.close();
    } catch {
      /* ignore */
    }
    await ws.releaseLock();
  }
}

describe("model usage recording", () => {
  it("records token and cache diagnostics per request path", async () => {
    await withWorkspace((ws) => {
      recordModelUsage(ws, {
        path: "pi-chat",
        model: "model-a",
        input: 120,
        output: 30,
        cacheRead: 80,
        cacheWrite: 12,
        requestId: "req-1",
      });
      recordModelUsage(ws, {
        path: "probe",
        model: "model-b",
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        requestId: "req-2",
      });

      expect(listModelUsage(ws)).toEqual([
        {
          path: "pi-chat",
          model: "model-a",
          input: 120,
          output: 30,
          cacheRead: 80,
          cacheWrite: 12,
          requestId: "req-1",
        },
        {
          path: "probe",
          model: "model-b",
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          requestId: "req-2",
        },
      ]);
    });
  });

  it("is best-effort and never throws into the request path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "margin-usage-"));
    dirs.push(root);
    const ws = await openWorkspace(root);
    ws.db.close();
    await ws.releaseLock();
    expect(() =>
      recordModelUsage(ws, {
        path: "legacy",
        model: "model-a",
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        requestId: "req-x",
      }),
    ).not.toThrow();
  });
});
