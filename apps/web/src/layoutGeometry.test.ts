import { describe, expect, it } from "vitest";
import { clampFloatRect, defaultFloatRect, readableMobilePageScale } from "./layoutGeometry";

describe("float layout geometry", () => {
  it("keeps a restored window inside the viewport using its actual size", () => {
    expect(clampFloatRect(
      { x: 900, y: 740, width: 500, height: 600 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 692, y: 292, width: 500, height: 600 });
  });

  it("does not demand desktop minimums from a narrow viewport", () => {
    expect(defaultFloatRect({ width: 320, height: 280 })).toEqual({
      x: 8,
      y: 8,
      width: 304,
      height: 264,
    });
  });

  it("keeps a Word page readable on phones instead of forcing full-page fit", () => {
    expect(readableMobilePageScale(794, 370)).toBe(0.72);
    expect(readableMobilePageScale(794, 748)).toBeCloseTo(748 / 794);
    expect(readableMobilePageScale(794, 900)).toBe(1);
  });
});
