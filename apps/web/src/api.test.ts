import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
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
});
