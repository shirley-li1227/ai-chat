import type { ProviderType } from "./types";

export interface ProviderPreset {
  type: ProviderType;
  label: string;
  description: string;
  defaultBaseUrl: string;
  defaultModel: string;
  /** 多选下拉里预置的模型，按从省到强排列（服务端据此得出换档顺序）；只是常用值提示，用户仍可自定义输入 */
  modelOptions: string[];
  /** 自定义模型输入的占位文案 */
  modelPlaceholder: string;
  /** 这一家的档位说明（哪一档更省、哪一档更强），与换档规则一起展示 */
  modelHint: string;
  apiKeyPlaceholder: string;
  /** 界面提示用的 Key 形态说明，真正的格式校验只在后端 PROVIDER_REGISTRY 里做一份 */
  apiKeyHint: string;
  docsUrl: string;
}

export const PROVIDER_PRESETS: Record<ProviderType, ProviderPreset> = {
  deepseek: {
    type: "deepseek",
    label: "DeepSeek",
    description: "深度求索官方开放接口，兼容 OpenAI Chat Completions 协议。",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    modelOptions: [
      "deepseek-flash",
      "deepseek-chat",
      "deepseek-v4-pro",
      "deepseek-reasoner",
    ],
    modelPlaceholder: "输入模型 id，例如 deepseek-chat",
    modelHint:
      "常用模型：deepseek-flash、deepseek-chat、deepseek-v4-pro、deepseek-reasoner。",
    apiKeyPlaceholder: "sk-...",
    apiKeyHint: "DeepSeek 密钥以 sk- 开头。",
    docsUrl: "https://api-docs.deepseek.com/zh-cn/",
  },
  zhipu: {
    type: "zhipu",
    label: "智谱 GLM",
    description:
      "智谱开放平台的 OpenAI 兼容端点，baseUrl 需带上 /api/paas/v4 路径。",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.3",
    modelOptions: ["glm-5.3-air", "glm-5.3-flash", "glm-5.3"],
    modelPlaceholder: "输入模型 id，例如 glm-5.3",
    modelHint: "常用模型：glm-5.3-air、glm-5.3-flash、glm-5.3。",
    apiKeyPlaceholder: "id.secret",
    apiKeyHint: "智谱密钥形如「id.secret」，以点号分成两段。",
    docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
  },
};

export const PROVIDER_ORDER: ProviderType[] = ["deepseek", "zhipu"];

/**
 * localStorage 与后端响应里的 provider 都是外部字符串，
 * 用类型断言硬转会让未知取值一路混进 UI（拿到 undefined preset 直接白屏）。
 */
export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === "string" && Object.hasOwn(PROVIDER_PRESETS, value);
}

export function providerLabel(provider: ProviderType): string {
  return PROVIDER_PRESETS[provider].label;
}

/**
 * 与后端 PROVIDER_REGISTRY 的 baseUrl 规则同一口径：只收 https，允许带路径
 * （智谱的兼容端点是 https://open.bigmodel.cn/api/paas/v4）。
 */
const HTTPS_BASE_URL =
  /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(\/[A-Za-z0-9._~%\-/!]*)?$/;

export function isHttpsBaseUrl(baseUrl: string): boolean {
  return HTTPS_BASE_URL.test(baseUrl.trim());
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}
