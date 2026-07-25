/** Curated presets inspired by CC Switch (anthropic-compatible + OpenAI). */

export type ApiFormat = "anthropic" | "openai";

export type ProviderPreset = {
  id: string;
  name: string;
  apiFormat: ApiFormat;
  baseURL: string;
  model: string;
  /** How the key is sent. CC Switch Claude side mostly uses Bearer AUTH_TOKEN. */
  authStyle: "bearer" | "apikey";
  websiteUrl?: string;
  hint?: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "cc-switch-proxy",
    name: "CC Switch 本地代理",
    apiFormat: "anthropic",
    baseURL: "http://127.0.0.1:15721",
    model: "claude-sonnet-4-6",
    authStyle: "bearer",
    hint: "读取本机 CC Switch 代理；切换上游在 CC Switch 里完成",
  },
  {
    id: "anthropic-official",
    name: "Anthropic 官方",
    apiFormat: "anthropic",
    baseURL: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    authStyle: "apikey",
    websiteUrl: "https://console.anthropic.com/",
  },
  {
    id: "openai-official",
    name: "OpenAI 官方",
    apiFormat: "openai",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    authStyle: "bearer",
    websiteUrl: "https://platform.openai.com/",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    apiFormat: "anthropic",
    baseURL: "https://api.deepseek.com/anthropic",
    model: "deepseek-chat",
    authStyle: "bearer",
    websiteUrl: "https://platform.deepseek.com",
  },
  {
    id: "kimi",
    name: "Kimi",
    apiFormat: "anthropic",
    baseURL: "https://api.moonshot.cn/anthropic",
    model: "kimi-k2.5",
    authStyle: "bearer",
    websiteUrl: "https://platform.moonshot.cn",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    apiFormat: "anthropic",
    baseURL: "https://open.bigmodel.cn/api/anthropic",
    model: "glm-4.5",
    authStyle: "bearer",
    websiteUrl: "https://open.bigmodel.cn",
  },
  {
    id: "custom",
    name: "自定义",
    apiFormat: "openai",
    baseURL: "",
    model: "gpt-4o-mini",
    authStyle: "bearer",
    hint: "自填 Base URL / 模型 / Key",
  },
];
