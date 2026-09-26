import express from "express";
import { resolve } from "node:path";
import { config } from "./config.js";
import { normalizeBatch } from "./core.js";
import { createDrillsFromAnnotations, judgeDrillWithLlm, reverifySceneAnnotations, runPipeline } from "./pipeline.js";
import type { ExamTarget, GenerationResult, Judgment, LengthPreference, Level, Sense, VerificationReport } from "./types.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(resolve(process.cwd(), "public")));

app.get("/api/status", (_request, response) => response.json({ ready: Boolean(config.provider.llm.apiKey && config.provider.llm.model && config.provider.llm.endpoint), limits: config.batchSize }));
app.post("/api/generate", async (request, response) => {
  try {
    const body = request.body as { rawInput: string | string[]; batchIndex?: number; learnerLevel?: Level; examTarget?: ExamTarget; lengthPreference?: LengthPreference; history?: Array<{ senses: Sense[]; scene: GenerationResult; report: VerificationReport }> };
    const batch = normalizeBatch(body.rawInput, body.batchIndex ?? 1, { learnerLevel: body.learnerLevel ?? config.learnerLevel.default, examTarget: body.examTarget ?? "通用", lengthPreference: body.lengthPreference ?? "medium" });
    if (!batch.words.length) return response.status(400).json({ error: "请输入可处理的英文词汇" });
    if (batch.words.length < config.batchSize.min || batch.words.length > config.batchSize.max) return response.status(400).json({ error: `词批需包含 ${config.batchSize.min}-${config.batchSize.max} 个不同英文词` });
    response.json(await runPipeline(batch, body.history ?? []));
  } catch (error) { response.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/drill/judge", async (request, response) => {
  try {
    const { sentence, sense, prompt } = request.body as { sentence: string; sense: Sense; prompt: string };
    if (!sentence?.trim() || !sense || !prompt?.trim()) return response.status(400).json({ error: "缺少练习题目、练习句或义项" });
    response.json(await judgeDrillWithLlm(sentence, sense, prompt));
  } catch (error) { response.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/annotations/reverify", async (request, response) => {
  try {
    const { senses, scene } = request.body as { senses: Sense[]; scene: GenerationResult };
    if (!Array.isArray(senses) || !scene?.sceneText || !Array.isArray(scene.occurrences)) return response.status(400).json({ error: "缺少场景标注或义项数据" });
    response.json(await reverifySceneAnnotations(senses, scene));
  } catch (error) { response.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/drills/generate", async (request, response) => {
  try {
    const { senses, scene, judgments } = request.body as { senses: Sense[]; scene: GenerationResult; judgments: Judgment[] };
    if (!Array.isArray(senses) || !scene?.sceneText || !Array.isArray(scene.occurrences) || !Array.isArray(judgments)) return response.status(400).json({ error: "缺少场景标注、语义校验或义项数据" });
    response.json({ drills: await createDrillsFromAnnotations(senses, scene, judgments) });
  } catch (error) { response.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/export-config", (_request, response) => response.json({ ...config, provider: { sense: config.provider.sense, llm: { configured: Boolean(config.provider.llm.apiKey && config.provider.llm.model && config.provider.llm.endpoint) }, sensitiveWordsConfigured: Boolean(config.provider.sensitiveWordsUrl) } }));

app.listen(config.port, () => console.log(`Lexiscape: http://localhost:${config.port}`));