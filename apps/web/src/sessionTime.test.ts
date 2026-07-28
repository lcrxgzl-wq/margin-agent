import { describe, expect, it } from "vitest";
import { formatSessionTime } from "./sessionTime";

const NOW = Date.parse("2026-07-28T12:00:00.000Z");

describe("formatSessionTime", () => {
  it("formats recent timestamps relatively", () => {
    expect(formatSessionTime("2026-07-28T11:59:40.000Z", NOW)).toBe("刚刚");
    expect(formatSessionTime("2026-07-28T11:45:00.000Z", NOW)).toBe("15 分钟前");
    expect(formatSessionTime("2026-07-28T09:00:00.000Z", NOW)).toBe("3 小时前");
    expect(formatSessionTime("2026-07-26T12:00:00.000Z", NOW)).toBe("2 天前");
  });

  it("falls back to a date beyond a week", () => {
    expect(formatSessionTime("2026-07-01T12:00:00.000Z", NOW)).toBe("7月1日");
  });

  it("tolerates invalid input and future timestamps", () => {
    expect(formatSessionTime("not-a-date", NOW)).toBe("");
    expect(formatSessionTime("2026-07-28T13:00:00.000Z", NOW)).toBe("刚刚");
  });
});
