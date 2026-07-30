import { describe, expect, it } from "vitest";
import { decideRoute } from "./router.js";

const credentials = { hasCredentials: true };

describe("PolicyRouter (full Pi)", () => {
  it.each([
    ["你好", "pi-default"],
    ["who are you", "pi-default"],
    ["重写这一段，使其更简洁", "pi-default"],
    ["讨论研究设计", "pi-default"],
    ["打开样章然后重写第一段", "pi-default"],
  ] as const)("routes %s to pi via %s when credentials exist", (message, matchedRule) => {
    expect(decideRoute({ message, ...credentials })).toEqual({
      route: "pi_session",
      matchedRule,
    });
  });

  it.each(["有哪些文件", "列出工作区文件", "list files", "ls", "打开样章", "打开 notes/a.md", '打开 "sport value.docx"', "读取 notes/a.md", "open paper.md"])(
    "routes deterministic host command %s without invoking Pi",
    (message) => {
      expect(decideRoute({ message, ...credentials })).toEqual({
        route: "host_command",
        matchedRule: "host-command",
      });
    },
  );

  it("uses the offline planner without credentials for all categories", () => {
    for (const message of ["讨论研究设计", "重写这一段", "你好"]) {
      expect(decideRoute({ message, hasCredentials: false })).toEqual({
        route: "offline_planner",
        matchedRule: "missing-credentials",
      });
    }
  });

  it("honors explicit engine-simple over credentials", () => {
    expect(
      decideRoute({
        message: "讨论研究设计",
        ...credentials,
        engineEnv: "simple",
      }),
    ).toEqual({ route: "offline_planner", matchedRule: "engine-simple" });
  });

  it("engine-pi is unnecessary but still lands on pi-default when credentials exist", () => {
    // engine-pi rule removed; pi-default covers it
    expect(
      decideRoute({ message: "重写这一段", ...credentials, engineEnv: "pi" }),
    ).toEqual({ route: "pi_session", matchedRule: "pi-default" });
  });
});
