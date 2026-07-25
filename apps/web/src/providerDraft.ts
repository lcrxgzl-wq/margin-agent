export type ProviderApiFormat = "openai" | "anthropic";
export type ProviderAuthStyle = "bearer" | "apikey";

function stripEndpoint(pathname: string): string {
  return pathname
    .replace(/\/+$/, "")
    .replace(/\/(?:v1\/messages|chat\/completions|responses|models|messages)$/i, "")
    .replace(/\/+$/, "");
}

export function defaultAuthStyle(format: ProviderApiFormat): ProviderAuthStyle {
  return format === "openai" ? "bearer" : "apikey";
}

export function normalizeBaseUrlForFormat(
  value: string,
  format: ProviderApiFormat,
): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    let path = stripEndpoint(url.pathname);
    if (format === "openai") {
      if (!/\/v1$/i.test(path)) path = `${path}/v1`;
    } else {
      path = path.replace(/\/v1$/i, "");
    }
    url.pathname = path || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed;
  }
}

export function completionEndpoint(value: string, format: ProviderApiFormat): string {
  const base = normalizeBaseUrlForFormat(value, format);
  if (!/^https?:\/\//i.test(base)) return "";
  return `${base}${format === "openai" ? "/chat/completions" : "/v1/messages"}`;
}
