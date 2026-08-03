import type { SessionContextUsage } from "./api";

function compactTokens(value: number): string {
  const tokens = Math.max(0, Math.round(value));
  if (tokens < 1_000) return String(tokens);
  const thousands = tokens / 1_000;
  const digits = tokens >= 100_000 || tokens % 1_000 === 0 ? 0 : 1;
  return `${thousands.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}k`;
}

export function contextUsageCopy(usage: SessionContextUsage): {
  label: string;
  title: string;
} {
  const used = Math.max(0, Math.round(usage.usedTokens));
  const window = Math.max(0, Math.round(usage.contextWindowTokens));
  return {
    label: `上下文${usage.usageEstimated ? "（估算）" : ""} ${compactTokens(used)} / ${compactTokens(window)}`,
    title: `${usage.usageEstimated ? "当前会话估算" : "当前会话"} ${used.toLocaleString("zh-CN")} tokens；模型上下文窗口 ${window.toLocaleString("zh-CN")} tokens`,
  };
}
