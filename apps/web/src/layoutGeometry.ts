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
