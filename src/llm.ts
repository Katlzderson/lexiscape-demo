import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { config } from "./config.js";

const providerRegistry = {
  deepseek: { label: "DeepSeek", endpoint: "https://api.deepseek.com" },
  openai: { label: "OpenAI", endpoint: "https://api.openai.com/v1" },
  openrouter: { label: "OpenRouter", endpoint: "https://openrouter.ai/api/v1" },
  siliconflow: { label: "硅基流动", endpoint: "https://api.siliconflow.cn/v1" },
  moonshot: { label: "Moonshot", endpoint: "https://api.moonshot.cn/v1" },
  zhipu: { label: "智谱 AI", endpoint: "https://open.bigmodel.cn/api/paas/v4" },
  dashscope: { label: "通义千问", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
} as const;

export type LlmCredentials = { provider: keyof typeof providerRegistry; model: string; apiKey: string };

const credentialsSchema = z.object({
  provider: z.enum(Object.keys(providerRegistry) as [keyof typeof providerRegistry, ...(keyof typeof providerRegistry)[]]),
  model: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:/-]+$/, "模型名称包含不允许的字符"),
  apiKey: z.string().trim().min(8, "API Key 长度不足").max(512, "API Key 过长").regex(/^[\x21-\x7E]+$/, "API Key 只能包含半角英文字符，不能包含中文或空格"),
}).strict();

const credentialContext = new AsyncLocalStorage<LlmCredentials>();

export const publicLlmProviders = Object.entries(providerRegistry).map(([id, provider]) => ({ id, label: provider.label }));

export function parseLlmCredentials(value: unknown): LlmCredentials {
  return credentialsSchema.parse(value);
}

export function withLlmCredentials<T>(credentials: LlmCredentials, operation: () => Promise<T>): Promise<T> {
  return credentialContext.run(credentials, operation);
}

export function currentLlmModel(): string {
  return credentialContext.getStore()?.model ?? "unknown";
}

export function currentLlmCacheScope(): string {
  const credentials = credentialContext.getStore();
  if (!credentials) throw new Error("请先在当前页面配置模型服务");
  return `${credentials.provider}:${credentials.model}`;
}

export class LlmServiceError extends Error {
  constructor(public readonly status: number) {
    super(LlmServiceError.messageFor(status));
    this.name = "LlmServiceError";
  }

  private static messageFor(status: number): string {
    if (status === 401 || status === 403) return `模型服务返回 ${status}：API Key 无效或没有该模型的访问权限`;
    if (status === 402) return "模型服务返回 402：账户余额不足或尚未开通计费，请前往供应商控制台检查余额与支付状态";
    if (status === 404) return "模型服务返回 404：模型名称不存在或当前供应商不提供该模型";
    if (status === 429) return "模型服务返回 429：请求过于频繁或账户额度已用尽，请稍后再试";
    if (status >= 500) return `模型服务暂时不可用（${status}），请稍后再试`;
    return `模型服务返回 ${status}，请检查供应商、模型名称和请求权限`;
  }
}

export async function renderPrompt(path: string, values: Record<string, unknown>): Promise<string> {
  let template = await readFile(resolve(process.cwd(), path), "utf8");
  for (const [key, value] of Object.entries(values)) template = template.replaceAll(`{{${key}}}`, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return template;
}

export async function callLlm(prompt: string, temperature: number = config.provider.llm.temperature): Promise<{ data: unknown; latencyMs: number }> {
  const credentials = credentialContext.getStore();
  if (!credentials) throw new Error("请先在当前页面配置模型服务");
  const provider = providerRegistry[credentials.provider];
  const started = Date.now();
  for (let attempt = 1; attempt <= config.provider.llm.jsonAttempts; attempt++) {
    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${credentials.apiKey}` },
      body: JSON.stringify({
        model: credentials.model,
        temperature,
        max_tokens: config.provider.llm.maxTokens,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) throw new LlmServiceError(response.status);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("模型服务未返回内容");
    try {
      const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return { data: JSON.parse(cleaned), latencyMs: Date.now() - started };
    } catch {
      if (attempt === config.provider.llm.jsonAttempts) throw new Error("模型服务连续返回非 JSON 内容");
    }
  }
  throw new Error("模型服务连续返回非 JSON 内容");
}