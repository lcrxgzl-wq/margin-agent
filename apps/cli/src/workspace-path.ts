/** Filesystem path matching is case-insensitive on Windows and case-sensitive elsewhere. */
export function workspacePathComparisonKey(
  relativePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? relativePath.toLowerCase() : relativePath;
}
