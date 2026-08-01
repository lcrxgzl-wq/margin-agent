export type FloatRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ViewportSize = {
  width: number;
  height: number;
};

const FLOAT_MIN_WIDTH = 340;
const FLOAT_MIN_HEIGHT = 360;

export function readableMobilePageScale(
  pageWidth: number,
  availableWidth: number,
): number {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0) return 1;
  const fitted = Math.max(0, availableWidth) / pageWidth;
  return Math.min(1, Math.max(0.72, fitted));
}

export function clampFloatRect(rect: FloatRect, viewport: ViewportSize): FloatRect {
  const availableWidth = Math.max(0, viewport.width - 16);
  const availableHeight = Math.max(0, viewport.height - 16);
  const width = Math.min(availableWidth, Math.max(Math.min(FLOAT_MIN_WIDTH, availableWidth), rect.width));
  const height = Math.min(availableHeight, Math.max(Math.min(FLOAT_MIN_HEIGHT, availableHeight), rect.height));
  return {
    x: Math.max(8, Math.min(viewport.width - width - 8, rect.x)),
    y: Math.max(8, Math.min(viewport.height - height - 8, rect.y)),
    width,
    height,
  };
}

export function defaultFloatRect(viewport: ViewportSize): FloatRect {
  const width = Math.min(420, Math.max(FLOAT_MIN_WIDTH, viewport.width - 32));
  const height = Math.min(720, Math.max(FLOAT_MIN_HEIGHT, viewport.height - 96));
  return clampFloatRect(
    { x: viewport.width - width - 18, y: 64, width, height },
    viewport,
  );
}

export function defaultTranslationFloatRect(
  anchor: { x: number; y: number },
  viewport: ViewportSize,
): FloatRect {
  const width = Math.min(520, Math.max(FLOAT_MIN_WIDTH, viewport.width - 24));
  const height = Math.min(380, Math.max(FLOAT_MIN_HEIGHT, viewport.height - 24));
  const belowTop = anchor.y + 18;
  const preferredTop = belowTop + height > viewport.height - 8
    ? anchor.y - height - 18
    : belowTop;
  return clampFloatRect(
    { x: anchor.x - width / 2, y: preferredTop, width, height },
    viewport,
  );
}

export function defaultThreadFloatRect(
  anchor: { x: number; y: number } | null,
  viewport: ViewportSize,
): FloatRect {
  const margin = 12;
  const width = Math.min(520, Math.max(0, viewport.width - margin * 2));
  const height = Math.min(420, Math.max(0, viewport.height - margin * 2));
  const preferredLeft = anchor ? anchor.x - width / 2 : viewport.width - width - 56;
  const belowTop = anchor ? anchor.y + 18 : 96;
  const preferredTop = anchor && belowTop + height > viewport.height - margin
    ? anchor.y - height - 18
    : belowTop;
  return {
    x: Math.max(margin, Math.min(viewport.width - width - margin, preferredLeft)),
    y: Math.max(margin, Math.min(viewport.height - height - margin, preferredTop)),
    width,
    height,
  };
}

export function resizeFloatRectFromBottomRight(
  rect: FloatRect,
  delta: { x: number; y: number },
  viewport: ViewportSize,
): FloatRect {
  const availableWidth = Math.max(0, viewport.width - rect.x - 8);
  const availableHeight = Math.max(0, viewport.height - rect.y - 8);
  return {
    ...rect,
    width: Math.min(
      availableWidth,
      Math.max(Math.min(FLOAT_MIN_WIDTH, availableWidth), rect.width + delta.x),
    ),
    height: Math.min(
      availableHeight,
      Math.max(Math.min(FLOAT_MIN_HEIGHT, availableHeight), rect.height + delta.y),
    ),
  };
}
