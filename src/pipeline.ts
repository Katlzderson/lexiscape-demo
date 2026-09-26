import { z } from "zod";
import { config } from "./config.js";
import { computeCapacity, computeEffectiveLengthRange, reconcileGeneration, scheduleDeferrals, verifyPosition } from "./core.js";
import { callLlm, currentLlmModel, renderPrompt } from "./llm.js";
import { getSenses, validateEntries } from "./providers.js";
import type { BatchInput, Drill, GenerationResult, Judgment, Sense, StoredBatch, VerificationReport } from "./types.js";

const generationSchema = z.object({
  sceneText: z.string(), sceneTitle: z.string(), sceneTitleZh: z.string(), sceneSummaryZh: z.string(), wordCount: z.number(),
  occurrences: z.array(z.object({ word: z.string(), surfaceForm: z.string(), charStart: z.number(), charEnd: z.number(), senseId: z.string(), sentenceIndex: z.number(), contextSnippet: z.string() })),
  uncovered: z.array(z.union([
    z.object({ word: z.string(), senseId: z.string(), reason: z.string() }),
    z.string().transform((reason) => ({ word: "", senseId: "", reason })),
  ])),
  continuity: z.object({ plotSummary: z.string(), characters: z.array(z.string()), setting: z.string() }),
});
const judgmentsSchema = z.object({ judgments: z.array(z.object({ occurrenceId: z.string(), expectedSenseId: z.string(), actualSenseId: z.string().nullable(), word: z.string(), charStart: z.number(), verdict: z.enum(["correct", "wrong_sense", "ambiguous", "not_found"]), confidence: z.number(), reason: z.string() })).min(1) });
const narrativeSchema = z.object({ passed: z.boolean(), languagePassed: z.boolean(), confidence: z.number(), causalChain: z.array(z.string()), issues: z.array(z.string()), languageIssues: z.array(z.string()), correction: z.string() });
const drillsSchema = z.object({ drills: z.array(z.object({ word: z.string(), senseId: z.string(), prompt: z.string() })) });
const drillJudgmentSchema = z.object({
  verdict: z.enum(["pass", "revise"]), instructionFollowed: z.boolean(), wordPresent: z.boolean(), senseCorrect: z.boolean(), grammarCorrect: z.boolean(), natural: z.boolean(),
  issues: z.array(z.string()), feedback: z.string(), correctedSentence: z.string(),
});

export function verificationScore(report: VerificationReport): number {
  return (report.positional.passed ? 2 : 0)
    + (report.narrative.passed ? 2 : report.narrative.confidence)
    + (report.narrative.languagePassed ? 1 : 0)
    + report.semantic.coverageRate * 3;
}

export function summarizeSemantic(targets: Sense[], judgments: Judgment[], confidenceMin: number) {
  const targetIds = new Set(targets.map((sense) => sense.senseId));
  const relevant = judgments.filter((judgment) => targetIds.has(judgment.senseId));
  const normalized = relevant.map((judgment) => judgment.confidence < confidenceMin ? { ...judgment, verdict: "ambiguous" as const, reason: `${judgment.reason}（置信度低于阈值）` } : judgment);
  const completed = targets.flatMap((target) => {
    const matches = normalized.filter((judgment) => judgment.senseId === target.senseId);
    return matches.length ? matches : [{ senseId: target.senseId, word: target.word, charStart: -1, verdict: "not_found" as const, confidence: 1, reason: "正文中没有可供校验的该目标义项出现位置" }];
  });
  const coveredIds = new Set(completed.filter((item) => item.verdict === "covered").map((item) => item.senseId));
  return { judgments: completed, coveredCount: coveredIds.size, targetCount: targets.length, coverageRate: targets.length ? coveredIds.size / targets.length : 0, lowConfidenceCount: completed.filter((item) => item.confidence < confidenceMin).length };
}

async function assertContentSafe(text: string): Promise<void> {
  if (!config.provider.sensitiveWordsUrl) return;
  const response = await fetch(config.provider.sensitiveWordsUrl);
  if (!response.ok) throw new Error(`敏感词数据源返回 ${response.status}`);
  const payload = await response.json() as string[] | { words?: string[] };
  const words = Array.isArray(payload) ? payload : payload.words ?? [];
  const normalized = text.toLowerCase();
  if (words.some((word) => word && normalized.includes(word.toLowerCase()))) throw new Error("生成内容未通过运行时安全词源检查");
}

function rankSenses(senses: Sense[], previouslyCovered: string[]): Sense[] {
  const frequency = { high: 3, medium: 2, low: 1 };
  return [...senses].map((sense) => {
    const unseen = !previouslyCovered.includes(sense.senseId);
    const score = (frequency[sense.examFreq ?? "medium"] * config.schedule.sortWeights.examFrequency) + (unseen ? config.schedule.sortWeights.unseen : 0);
    return { ...sense, rankReason: `${sense.examFreq ?? "medium"} 频；${unseen ? "尚未覆盖，优先" : "此前已覆盖，后置"}；排序分 ${score}` };
  }).sort((a, b) => Number(b.rankReason?.match(/\d+$/)?.[0] ?? 0) - Number(a.rankReason?.match(/\d+$/)?.[0] ?? 0));
}

function selectTargets(batch: BatchInput, senses: Sense[], previouslyCovered: string[]) {
  const capacity = computeCapacity(batch.lengthPreference, batch.words.length, config);
  const ranked = rankSenses(senses, previouslyCovered);
  return { capacity, ranked, selected: ranked, deferred: [] as Sense[] };
}

async function generate(batch: BatchInput, targets: Sense[], attempt: number, continuity: unknown, correction: string[]) {
  const range = computeEffectiveLengthRange(batch.lengthPreference, targets.length, config);
  const prompt = await renderPrompt(config.prompts.scene, { batchId: batch.batchId, targetLevel: batch.learnerLevel, sceneLengthRange: range, targets, continuityContext: continuity ?? {}, correction });
  const { data, latencyMs } = await callLlm(prompt);
  const parsed = generationSchema.parse(data);
  await assertContentSafe(parsed.sceneText);
  return reconcileGeneration({ ...parsed, batchId: batch.batchId, generationMeta: { model: currentLlmModel(), attempt, promptVersion: "1.1", latencyMs } } satisfies GenerationResult);
}

async function verifySemantic(result: GenerationResult, targets: Sense[]): Promise<{ judgments: Judgment[]; scene: GenerationResult }> {
  const targetMap = new Map(targets.map((sense) => [sense.senseId, sense]));
  const indexed = result.occurrences.map((occurrence, index) => ({ occurrence, occurrenceId: `occ-${index}` }));
  const groups: typeof indexed[] = [];
  for (let index = 0; index < indexed.length; index += config.generation.semanticConcurrency) groups.push(indexed.slice(index, index + config.generation.semanticConcurrency));
  const judgments: Judgment[] = [];
  const correctedOccurrences = [...result.occurrences];
  for (const group of groups) {
    const items = group.map(({ occurrence, occurrenceId }) => ({ occurrenceId, word: occurrence.word, surfaceForm: occurrence.surfaceForm, charStart: occurrence.charStart, expectedSenseId: occurrence.senseId, expectedSense: targetMap.get(occurrence.senseId), candidateSenses: targets.filter((sense) => sense.word === occurrence.word), contextSnippet: occurrence.contextSnippet }));
    const prompt = await renderPrompt(config.prompts.judgeSense, { items });
    const { data } = await callLlm(prompt, config.provider.llm.taskTemperature.verifier);
    const returned = judgmentsSchema.parse(data).judgments;
    const byId = new Map(returned.map((judgment) => [judgment.occurrenceId, judgment]));
    if (returned.length !== items.length || byId.size !== items.length || items.some((item) => !byId.has(item.occurrenceId))) throw new Error("语义校验器没有逐项返回完整结果");
    for (const item of items) {
      const judgment = byId.get(item.occurrenceId)!;
      if (judgment.word !== item.word || judgment.charStart !== item.charStart || judgment.expectedSenseId !== item.expectedSenseId) throw new Error(`语义校验器改变了输入标识：${item.occurrenceId}`);
      const actualSense = judgment.actualSenseId ? targetMap.get(judgment.actualSenseId) : undefined;
      const confirmed = judgment.confidence >= config.coverage.confidenceMin
        && actualSense?.word === item.word
        && ((judgment.verdict === "correct" && judgment.actualSenseId === item.expectedSenseId) || (judgment.verdict === "wrong_sense" && judgment.actualSenseId !== item.expectedSenseId));
      if (confirmed) {
        const occurrenceIndex = Number(item.occurrenceId.slice(4));
        correctedOccurrences[occurrenceIndex] = { ...correctedOccurrences[occurrenceIndex], senseId: judgment.actualSenseId! };
        judgments.push({ senseId: judgment.actualSenseId!, sourceSenseId: item.expectedSenseId, word: item.word, charStart: item.charStart, verdict: "covered", confidence: judgment.confidence, reason: judgment.reason });
      } else {
        judgments.push({ senseId: item.expectedSenseId, sourceSenseId: item.expectedSenseId, word: item.word, charStart: item.charStart, verdict: judgment.confidence < config.coverage.confidenceMin ? "ambiguous" : judgment.verdict === "not_found" ? "not_found" : "ambiguous", confidence: judgment.confidence, reason: judgment.reason });
      }
    }
  }
  return { judgments, scene: { ...result, occurrences: correctedOccurrences } };
}

async function verifyNarrative(result: GenerationResult) {
  const prompt = await renderPrompt(config.prompts.judgeCoherence, { sceneText: result.sceneText });
  const { data } = await callLlm(prompt, config.provider.llm.taskTemperature.coherence);
  const judgment = narrativeSchema.parse(data);
  return { ...judgment, passed: judgment.passed && judgment.confidence >= config.coverage.coherenceMin };
}

export async function reverifySceneAnnotations(senses: Sense[], scene: GenerationResult) {
  const result = await verifySemantic(scene, senses);
  return { scene: result.scene, semantic: summarizeSemantic(senses, result.judgments, config.coverage.confidenceMin) };
}

export function verifiedSenseIds(scene: GenerationResult, senses: Sense[], judgments: Judgment[]): Set<string> {
  const senseMap = new Map(senses.map((sense) => [sense.senseId, sense]));
  const verified = new Set(judgments
    .filter((judgment) => judgment.verdict === "covered")
    .map((judgment) => `${judgment.word}:${judgment.senseId}:${judgment.charStart}`));
  const ids = new Set<string>();
  let previousEnd = -1;
  for (const occurrence of [...scene.occurrences].sort((left, right) => left.charStart - right.charStart)) {
    const sense = senseMap.get(occurrence.senseId);
    const { charStart, charEnd, surfaceForm } = occurrence;
    const inRange = Number.isInteger(charStart) && Number.isInteger(charEnd) && charStart >= 0 && charStart < charEnd && charEnd <= scene.sceneText.length;
    const key = `${occurrence.word}:${occurrence.senseId}:${charStart}`;
    if (!verified.has(key) || !sense || sense.word !== occurrence.word || !inRange || charStart < previousEnd || scene.sceneText.slice(charStart, charEnd) !== surfaceForm) continue;
    const before = scene.sceneText[charStart - 1] ?? "";
    const after = scene.sceneText[charEnd] ?? "";
    if (/[A-Za-z'-]/.test(before) || /[A-Za-z'-]/.test(after)) continue;
    ids.add(occurrence.senseId);
    previousEnd = charEnd;
  }
  return ids;
}

async function createDrills(targets: Sense[], coveredIds: Set<string>): Promise<Drill[]> {
  const source = targets.filter((sense) => coveredIds.has(sense.senseId)).slice(0, 4);
  if (!source.length) return [];
  const prompt = await renderPrompt(config.prompts.drill, { targets: source });
  const { data } = await callLlm(prompt, config.provider.llm.taskTemperature.drill);
  const sourceMap = new Map(source.map((sense) => [sense.senseId, sense]));
  return drillsSchema.parse(data).drills.filter((drill) => sourceMap.has(drill.senseId)).map((drill) => ({ ...drill, word: sourceMap.get(drill.senseId)!.word, drillId: crypto.randomUUID(), kind: "学习" }));
}

export async function createDrillsFromAnnotations(senses: Sense[], scene: GenerationResult, judgments: Judgment[]): Promise<Drill[]> {
  return createDrills(senses, verifiedSenseIds(scene, senses, judgments));
}

export async function runPipeline(batch: BatchInput, history: Array<{ senses: Sense[]; scene: GenerationResult; report: VerificationReport }> = []): Promise<StoredBatch & { trace: string[] }> {
  const trace = ["配置加载完成", "开始验证精确词条"];
  const validation = await validateEntries(batch.words);
  const invalid = validation.filter((item) => !item.valid);
  batch.words = [...new Set(validation.filter((item) => item.valid).map((item) => item.entry.toLowerCase().trim().replace(/\s+/g, " ")))];
  trace.push(...validation.map((item) => `${item.entry}: ${item.valid ? "有效" : `无效（${item.reason}）`}`));
  if (batch.words.length < config.batchSize.min || batch.words.length > config.batchSize.max) {
    const detail = invalid.length ? `无效词条：${invalid.map((item) => `${item.entry}（${item.reason}）`).join("；")}` : "";
    throw new Error(`有效英文词条共 ${batch.words.length} 个，不在 ${config.batchSize.min}-${config.batchSize.max} 个范围内，无法生成。${detail}`);
  }
  trace.push("开始获取运行时义项");
  const fetched = await getSenses(batch.words);
  trace.push(...fetched.trace);
  for (const word of fetched.unavailable) batch.dropped.push({ token: word, reason: "no-sense-data" });
  batch.words = batch.words.filter((word) => !fetched.unavailable.includes(word));
  if (!batch.words.length) throw new Error("义项数据服务不可用，无法生成场景（D-3）");
  const previousCovered = history.flatMap((item) => item.report.semantic.judgments.filter((judgment) => judgment.verdict === "covered").map((judgment) => judgment.senseId));
  const plan = selectTargets(batch, fetched.senses, previousCovered);
  const effectiveLengthRange = computeEffectiveLengthRange(batch.lengthPreference, plan.selected.length, config);
  trace.push(`容量: ${plan.capacity.maxSceneWords} 词 / 理论上限 ${plan.capacity.maxInstances} 义项 / 本批精确词条共 ${plan.selected.length} 个义项`);
  if (!plan.capacity.feasible || plan.selected.length > plan.capacity.maxInstances) throw new Error(`本批精确词条共有 ${plan.selected.length} 个义项，超过当前篇幅最多 ${plan.capacity.maxInstances} 个义项的容量；请选择更长篇幅或减少词条。`);
  const continuity = history.at(-1)?.scene.continuity ?? null;
  let best: { scene: GenerationResult; report: VerificationReport } | null = null;
  let corrections: string[] = [];
  for (let attempt = 1; attempt <= config.generation.maxRetries; attempt++) {
    trace.push(`生成与校验：第 ${attempt} 次尝试`);
    let scene: GenerationResult;
    try {
      scene = await generate(batch, plan.selected, attempt, continuity, corrections);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      corrections = [`输出结构无效：${reason.slice(0, 500)}。必须严格按 JSON 契约重发完整结果。`];
      trace.push(`第 ${attempt} 次生成结构无效，进入重试`);
      continue;
    }
    const positional = verifyPosition(scene, batch, fetched.senses, effectiveLengthRange, config);
    let judgments: Judgment[] = [];
    let narrative = { passed: false, languagePassed: false, confidence: 0, causalChain: [] as string[], issues: ["位置校验未通过，未执行篇章校验"], languageIssues: [] as string[], correction: "先修复结构化标注。" };
    if (positional.passed) {
      const [semanticResult, narrativeResult] = await Promise.allSettled([verifySemantic(scene, plan.selected), verifyNarrative(scene)]);
      if (semanticResult.status === "fulfilled") {
        judgments = semanticResult.value.judgments;
        scene = semanticResult.value.scene;
      }
      else trace.push(`第 ${attempt} 次语义校验失败：${semanticResult.reason instanceof Error ? semanticResult.reason.message : String(semanticResult.reason)}`);
      if (narrativeResult.status === "fulfilled") narrative = narrativeResult.value;
      else narrative = { passed: false, languagePassed: false, confidence: 0, causalChain: [], issues: [`篇章校验服务失败：${narrativeResult.reason instanceof Error ? narrativeResult.reason.message : String(narrativeResult.reason)}`], languageIssues: [], correction: "保留正文并标记为未完全验收。" };
    }
    const semantic = summarizeSemantic(plan.selected, judgments, config.coverage.confidenceMin);
    const accepted = positional.passed && narrative.passed && narrative.languagePassed && semantic.coverageRate >= config.coverage.threshold;
    corrections = [...positional.checks.flatMap((check) => check.failures.map((failure) => `${check.code}: ${failure.expected} / ${failure.actual}`)), ...(!narrative.passed || !narrative.languagePassed ? [`篇章与语言审校：${[...narrative.issues, ...narrative.languageIssues].join("；")}。修正要求：${narrative.correction}`] : []), ...semantic.judgments.filter((item) => item.verdict !== "covered").map((item) => `${item.word}/${item.senseId}@${item.charStart}: ${item.verdict} - ${item.reason}`)];
    const report = { batchId: batch.batchId, attempt, positional, narrative, semantic, accepted, rejectReasons: corrections } as VerificationReport;
    const isBetter = !best || verificationScore(report) > verificationScore(best.report);
    if (isBetter) best = { scene, report };
    if (accepted) break;
  }
  if (!best) {
    const detail = corrections[0] ? `最近一次失败原因：${corrections[0]}` : "模型未返回符合数据契约的结果。";
    throw new Error(`模型连续 ${config.generation.maxRetries} 次都未返回可解析的正文。${detail}`);
  }
  const coveredIds = new Set(best.report.semantic.judgments.filter((item) => item.verdict === "covered").map((item) => item.senseId));
  const judgmentReason = new Map(best.report.semantic.judgments.map((item) => [item.senseId, item.verdict]));
  const deferred = [...plan.deferred.map((sense) => ({ word: sense.word, senseId: sense.senseId, reason: "capacity" as const })), ...plan.selected.filter((sense) => !coveredIds.has(sense.senseId)).map((sense) => ({ word: sense.word, senseId: sense.senseId, reason: judgmentReason.get(sense.senseId) ?? "not_found" }))];
  const deferrals = scheduleDeferrals(batch.batchId, batch.batchIndex, deferred, config);
  const degradation = best.report.accepted ? null : `已输出最多 ${config.generation.maxRetries} 轮校验中的第 ${best.report.attempt} 轮最佳稿，但未完全通过后台质量校验。只有经独立语义校验确认的位置才会显示释义。`;
  let drills: Drill[] = [];
  try { drills = await createDrillsFromAnnotations(plan.selected, best.scene, best.report.semantic.judgments); }
  catch (error) { trace.push(`练习题生成失败，不影响正文输出：${error instanceof Error ? error.message : String(error)}`); }
  trace.push(best.report.accepted ? "批次通过校验" : degradation!);
  return { batch, senses: plan.ranked, scene: best.scene, report: best.report, deferrals, degradation, drills, trace };
}

export async function judgeDrillWithLlm(sentence: string, sense: Sense, taskPrompt: string) {
  const prompt = await renderPrompt(config.prompts.judgeDrill, {
    word: sense.word, sentence, taskPrompt,
    sense: { pos: sense.pos, zhDef: sense.zhDef, enDef: sense.enDef, collocations: sense.collocations, surfaceForms: sense.surfaceForms ?? [] },
  });
  const { data } = await callLlm(prompt, config.provider.llm.taskTemperature.verifier);
  const judgment = drillJudgmentSchema.parse(data);
  const passed = judgment.instructionFollowed && judgment.wordPresent && judgment.senseCorrect && judgment.grammarCorrect && judgment.natural;
  return { ...judgment, verdict: passed ? "pass" as const : "revise" as const };
}