export * from "./contracts.js";

export function contentHash(_text: string): string {
  throw new Error("contentHash is unavailable in the browser");
}
