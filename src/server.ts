import express from "express";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { config } from "./config.js";
import { normalizeBatch } from "./core.js";
import { LlmServiceError, parseLlmCredentials, publicLlmProviders, withLlmCredentials } from "./llm.js";
import { createDrillsFromAnnotations, judgeDrillWithLlm, reverifySceneAnnotations, runPipeline } from "./pipeline.js";
import type { ExamTarget, GenerationResult, Judgment, LengthPreference, Level, Sense, VerificationReport } from "./types.js";

const app = express();
const errorStatus = (error: unknown) => error instanceof ZodError ? 400 : error instanceof LlmServiceError ? error.status : 502;
const errorMessage = (error: unknown) => error instanceof ZodError ? "模型配置无效，请检查供应商、模型名称和 API Key" : error instanceof Error ? error.message : String(error);
app.use(express.json({ limit: "1mb" }));
app.use((_request, response, next) => {
  response.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  });
  next();
});
app.use("/vendor/lucide", express.static(resolve(process.cwd(), "node_modules/lucide/dist/umd"), { immutable: true, maxAge: "1y" }));
app.use(express.static(resolve(process.cwd(), "public")));

app.get("/api/status", (_request, response) => response.json({ ready: true, requiresUserModel: true, limits: config.batchSize }));
app.get("/api/llm/providers", (_request, response) => response.json({ providers: publicLlmProviders }));
app.post("/api/generate", async (request, response) => {
  try {
    const body = request.body as { llm?: unknown; rawInput: string | string[]; batchIndex?: number; learnerLevel?: Level; examTarget?: ExamTarget; lengthPreference?: LengthPreference; history?: Array<{ senses: Sense[]; scene: GenerationResult; report: VerificationReport }> };
    const credentials = parseLlmCredentials(body.llm);
    delete body.llm;
    const batch = normalizeBatch(body.rawInput, body.batchIndex ?? 1, { learnerLevel: body.learnerLevel ?? config.learnerLevel.default, examTarget: body.examTarget ?? "通用", lengthPreference: body.lengthPreference ?? "medium" });
    if (!batch.words.length) return response.status(400).json({ error: "请输入可处理的英文词汇" });
    if (batch.words.length < config.batchSize.min || batch.words.length > config.batchSize.max) return response.status(400).json({ error: `词批需包含 ${config.batchSize.min}-${config.batchSize.max} 个不同英文词` });
    response.json(await withLlmCredentials(credentials, () => runPipeline(batch, body.history ?? [])));
  } catch (error) { response.status(errorStatus(error)).json({ error: errorMessage(error) }); }
});
app.post("/api/drill/judge", async (request, response) => {
  try {
    const body = request.body as { llm?: unknown; sentence: string; sense: Sense; prompt: string };
    const credentials = parseLlmCredentials(body.llm);
    delete body.llm;
    const { sentence, sense, prompt } = body;
    if (!sentence?.trim() || !sense || !prompt?.trim()) return response.status(400).json({ error: "缺少练习题目、练习句或义项" });
    response.json(await withLlmCredentials(credentials, () => judgeDrillWithLlm(sentence, sense, prompt)));
  } catch (error) { response.status(errorStatus(error)).json({ error: errorMessage(error) }); }
});
app.post("/api/annotations/reverify", async (request, response) => {
  try {
    const body = request.body as { llm?: unknown; senses: Sense[]; scene: GenerationResult };
    const credentials = parseLlmCredentials(body.llm);
    delete body.llm;
    const { senses, scene } = body;
    if (!Array.isArray(senses) || !scene?.sceneText || !Array.isArray(scene.occurrences)) return response.status(400).json({ error: "缺少场景标注或义项数据" });
    response.json(await withLlmCredentials(credentials, () => reverifySceneAnnotations(senses, scene)));
  } catch (error) { response.status(errorStatus(error)).json({ error: errorMessage(error) }); }
});
app.post("/api/drills/generate", async (request, response) => {
  try {
    const body = request.body as { llm?: unknown; senses: Sense[]; scene: GenerationResult; judgments: Judgment[] };
    const credentials = parseLlmCredentials(body.llm);
    delete body.llm;
    const { senses, scene, judgments } = body;
    if (!Array.isArray(senses) || !scene?.sceneText || !Array.isArray(scene.occurrences) || !Array.isArray(judgments)) return response.status(400).json({ error: "缺少场景标注、语义校验或义项数据" });
    response.json({ drills: await withLlmCredentials(credentials, () => createDrillsFromAnnotations(senses, scene, judgments)) });
  } catch (error) { response.status(errorStatus(error)).json({ error: errorMessage(error) }); }
});
app.get("/api/export-config", (_request, response) => response.json({ ...config, provider: { sense: config.provider.sense, llm: { byok: true, providers: publicLlmProviders }, sensitiveWordsConfigured: Boolean(config.provider.sensitiveWordsUrl) } }));

app.listen(config.port, () => console.log(`Lexiscape: http://localhost:${config.port}`));