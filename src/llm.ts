import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "./config.js";

export async function renderPrompt(path: string, values: Record<string, unknown>): Promise<string> {
  let template = await readFile(resolve(process.cwd(), path), "utf8");
  for (const [key, value] of Object.entries(values)) template = template.replaceAll(`{{${key}}}`, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return template;
}

export async function callLlm(prompt: string, temperature: number = config.provider.llm.temperature): Promise<{ data: unknown; latencyMs: number }> {
  if (!config.provider.llm.apiKey || !config.provider.llm.endpoint || !config.provider.llm.model) throw new Error("LLM_BASE_URL、LLM_MODEL 与 LLM_API_KEY 必须完整配置");
  const started = Date.now();
  for (let attempt = 1; attempt <= config.provider.llm.jsonAttempts; attempt++) {
    const response = await fetch(`${config.provider.llm.endpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.provider.llm.apiKey}` },
      body: JSON.stringify({
        model: config.provider.llm.model,
        temperature,
        max_tokens: config.provider.llm.maxTokens,
        thinking: { type: config.provider.llm.thinking ? "enabled" : "disabled" },
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`模型服务返回 ${response.status}: ${(await response.text()).slice(0, 240)}`);
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