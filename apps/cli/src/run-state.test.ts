import { describe, expect, it } from "vitest";
import { setBoundedMap } from "./run-state.js";

describe("setBoundedMap", () => {
  it("keeps the newest entries while allowing in-place updates", () => {
    const map = new Map<string, number>();
    setBoundedMap(map, "a", 1, 2);
    setBoundedMap(map, "b", 2, 2);
    setBoundedMap(map, "b", 3, 2);
    setBoundedMap(map, "c", 4, 2);
    expect([...map.entries()]).toEqual([
      ["b", 3],
      ["c", 4],
    ]);
  });
});
