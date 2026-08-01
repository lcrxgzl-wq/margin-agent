import { describe, expect, it } from "vitest";
import {
  clampFloatRect,
  defaultFloatRect,
  defaultThreadFloatRect,
  defaultTranslationFloatRect,
  readableMobilePageScale,
  resizeFloatRectFromBottomRight,
} from "./layoutGeometry";

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

  it("places the translation window above a low selection without covering its anchor", () => {
    expect(defaultTranslationFloatRect(
      { x: 1100, y: 850 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 672, y: 452, width: 520, height: 380 });
  });

  it("places the translation window below a high selection", () => {
    expect(defaultTranslationFloatRect(
      { x: 500, y: 100 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 240, y: 118, width: 520, height: 380 });
  });

  it("resizes from the lower-right corner without crossing the viewport", () => {
    expect(resizeFloatRectFromBottomRight(
      { x: 200, y: 100, width: 520, height: 380 },
      { x: 1000, y: 1000 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 200, y: 100, width: 992, height: 792 });
    expect(resizeFloatRectFromBottomRight(
      { x: 200, y: 100, width: 520, height: 380 },
      { x: -1000, y: -1000 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 200, y: 100, width: 340, height: 360 });
  });

  it("fits the translation window into a small viewport", () => {
    expect(defaultTranslationFloatRect(
      { x: 160, y: 140 },
      { width: 320, height: 280 },
    )).toEqual({ x: 8, y: 8, width: 304, height: 264 });
  });

  it("places an anchored thread above a low selection so the full window remains visible", () => {
    expect(defaultThreadFloatRect(
      { x: 500, y: 850 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 240, y: 412, width: 520, height: 420 });
  });

  it("places an anchored thread below a high selection", () => {
    expect(defaultThreadFloatRect(
      { x: 500, y: 100 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 240, y: 118, width: 520, height: 420 });
  });

  it("fits an anchored thread into a viewport smaller than its desktop minimum", () => {
    expect(defaultThreadFloatRect(
      { x: 160, y: 140 },
      { width: 320, height: 280 },
    )).toEqual({ x: 12, y: 12, width: 296, height: 256 });
  });

  it("keeps a Word page readable on phones instead of forcing full-page fit", () => {
    expect(readableMobilePageScale(794, 370)).toBe(0.72);
    expect(readableMobilePageScale(794, 748)).toBeCloseTo(748 / 794);
    expect(readableMobilePageScale(794, 900)).toBe(1);
  });
});
