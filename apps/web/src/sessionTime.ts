/** Compact relative timestamp for session rows (刚刚 / N 分钟前 / N 小时前 / N 天前 / M月D日). */
export function formatSessionTime(iso: string, now = Date.now()): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diff = Math.max(0, now - ts);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
