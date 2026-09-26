import type { AppConfig } from "./config.js";
import type { BatchInput, Capacity, DeferralPlan, GenerationResult, LengthPreference, Occurrence, Sense } from "./types.js";

export function normalizeBatch(raw: string | string[], batchIndex: number, options: { learnerLevel: BatchInput["learnerLevel"]; examTarget: BatchInput["examTarget"]; lengthPreference: LengthPreference }): BatchInput {
  const rawInput = Array.isArray(raw) ? raw : raw.split(/[\r\n,，;；]+/);
  const words: string[] = [];
  const dropped: BatchInput["dropped"] = [];
  const seen = new Set<string>();
  for (const original of rawInput) {
    const token = original.trim();
    if (!token) { dropped.push({ token, reason: "empty" }); continue; }
    const normalized = token.toLowerCase();
    if (!/^[a-z]+(?:[-'][a-z]+)*(?:\s+[a-z]+(?:[-'][a-z]+)*)*$/i.test(token)) { dropped.push({ token, reason: "non-english" }); continue; }
    if (seen.has(normalized)) { dropped.push({ token, reason: "duplicate" }); continue; }
    seen.add(normalized); words.push(normalized);
  }
  return { batchId: crypto.randomUUID(), batchIndex, rawInput, words, dropped, ...options, createdAt: new Date().toISOString() };
}

export function computeCapacity(preference: LengthPreference, batchSize: number, appConfig: AppConfig): Capacity {
  const range = appConfig.sceneLength[preference];
  const maxSceneWords = range.max;
  const maxInstances = Math.floor(maxSceneWords * appConfig.capacity.instanceDensity);
  const naturalInstances = Math.max(batchSize, Math.min(maxInstances, Math.floor(maxSceneWords / appConfig.capacity.narrativeWordsPerInstance)));
  const perWordCap = Math.max(1, Math.floor(naturalInstances * appConfig.capacity.perWordShareFactor / batchSize));
  return { maxSceneWords, maxInstances, naturalInstances, perWordCap, feasible: batchSize <= maxInstances };
}

export function computeEffectiveLengthRange(preference: LengthPreference, targetCount: number, appConfig: AppConfig) {
  const configured = appConfig.sceneLength[preference];
  const targetMinimum = Math.max(appConfig.capacity.minimumSceneWords, targetCount * appConfig.capacity.minimumWordsPerInstance);
  return { min: Math.min(configured.min, targetMinimum), max: configured.max };
}

export function verifyPosition(result: GenerationResult, batch: BatchInput, senses: Sense[], range: { min: number; max: number }, appConfig: AppConfig) {
  const failures = new Map<string, import("./types.js").CheckFailure[]>();
  const fail = (code: string, detail: import("./types.js").CheckFailure) => failures.set(code, [...(failures.get(code) ?? []), detail]);
  const senseMap = new Map(senses.map((sense) => [sense.senseId, sense]));
  result.occurrences.forEach((occ, index) => {
    const actual = result.sceneText.slice(occ.charStart, occ.charEnd);
    const before = result.sceneText[occ.charStart - 1] ?? "";
    const after = result.sceneText[occ.charEnd] ?? "";
    if (actual !== occ.surfaceForm || /[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)) fail("V-01", { occurrenceIndex: index, expected: `完整词形 ${occ.surfaceForm}`, actual });
    if (!batch.words.includes(occ.word)) fail("V-02", { occurrenceIndex: index, word: occ.word, expected: "batch word", actual: occ.word });
    if (senseMap.get(occ.senseId)?.word !== occ.word) fail("V-03", { occurrenceIndex: index, senseId: occ.senseId, expected: "sense of word", actual: occ.senseId });
    const snippetStart = result.sceneText.indexOf(occ.contextSnippet);
    if (snippetStart < 0 || occ.charStart < snippetStart || occ.charEnd > snippetStart + occ.contextSnippet.length) fail("V-04", { occurrenceIndex: index, expected: occ.contextSnippet, actual: "missing or outside snippet" });
  });
  const tolerance = appConfig.verify.lengthTolerance;
  const lower = range.min * (1 - tolerance), upper = range.max * (1 + tolerance);
  if (result.wordCount < lower || result.wordCount > upper) fail("V-05", { expected: `${lower}-${upper}`, actual: String(result.wordCount) });
  for (const word of batch.words) if (!result.occurrences.some((occ) => occ.word === word)) fail("V-06", { word, expected: "at least 1 occurrence", actual: "0" });
  const sorted = [...result.occurrences].sort((a, b) => a.charStart - b.charStart);
  for (let index = 1; index < sorted.length; index++) if (sorted[index - 1].charEnd > sorted[index].charStart) fail("V-07", { expected: "non-overlapping", actual: `${sorted[index - 1].charEnd}>${sorted[index].charStart}` });
  for (const marker of appConfig.verify.markerPatterns) if (result.sceneText.includes(marker)) fail("V-08", { expected: "clean text", actual: marker });
  const sentences = splitSentences(result.sceneText);
  result.occurrences.forEach((occ, index) => { if (!sentences[occ.sentenceIndex]?.includes(occ.surfaceForm)) fail("V-09", { occurrenceIndex: index, expected: String(occ.sentenceIndex), actual: "mismatch" }); });
  const hardCodes = ["V-01", "V-02", "V-03", "V-04", "V-05", "V-06", "V-07", "V-08"];
  const checks = Array.from({ length: 9 }, (_, index) => { const code = `V-0${index + 1}`; return { code, passed: !failures.has(code), failures: failures.get(code) ?? [] }; });
  return { passed: hardCodes.every((code) => !failures.has(code)), checks };
}

export function splitSentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((value) => value.trim()) ?? [];
}

export function reconcileGeneration(result: GenerationResult): GenerationResult {
  const sentenceMatches = [...result.sceneText.matchAll(/[^.!?]+[.!?]+|[^.!?]+$/g)];
  const usedStarts = new Set<number>();
  const occurrences = result.occurrences.map((occurrence) => {
    const candidates: number[] = [];
    let searchFrom = 0;
    while (searchFrom < result.sceneText.length) {
      const found = result.sceneText.indexOf(occurrence.surfaceForm, searchFrom);
      if (found < 0) break;
      const before = result.sceneText[found - 1] ?? "";
      const after = result.sceneText[found + occurrence.surfaceForm.length] ?? "";
      if (!usedStarts.has(found) && !/[A-Za-z]/.test(before) && !/[A-Za-z]/.test(after)) candidates.push(found);
      searchFrom = found + Math.max(1, occurrence.surfaceForm.length);
    }
    const charStart = candidates.sort((left, right) => Math.abs(left - occurrence.charStart) - Math.abs(right - occurrence.charStart))[0] ?? occurrence.charStart;
    usedStarts.add(charStart);
    const sentenceIndex = sentenceMatches.findIndex((match) => charStart >= (match.index ?? 0) && charStart < (match.index ?? 0) + match[0].length);
    const contextSnippet = sentenceIndex >= 0 ? sentenceMatches[sentenceIndex][0].trim() : occurrence.contextSnippet;
    return { ...occurrence, charStart, charEnd: charStart + occurrence.surfaceForm.length, sentenceIndex: sentenceIndex >= 0 ? sentenceIndex : occurrence.sentenceIndex, contextSnippet };
  });
  const wordCount = result.sceneText.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g)?.length ?? 0;
  return { ...result, wordCount, occurrences };
}

export function scheduleDeferrals(batchId: string, currentBatch: number, deferred: Array<{ word: string; senseId: string; reason: DeferralPlan["entries"][number]["reason"] }>, appConfig: AppConfig): DeferralPlan {
  const counts = new Map<string, number>();
  const entries = deferred.map((item) => {
    const ordinal = counts.get(item.word) ?? 0;
    counts.set(item.word, ordinal + 1);
    const targetBatchIndex = currentBatch + 1 + appConfig.schedule.minBatchGap + ordinal * (appConfig.schedule.minBatchGap + 1);
    return { ...item, targetBatchIndex, rationale: `当前场景未覆盖；按优先级安排到第 ${targetBatchIndex} 批次，并与同词其他义项分散。`, dispersalNote: "同词义项按批次间隔交错安排" };
  });
  const grouped = [...counts.entries()].filter(([, count]) => count > 1).map(([word, deferredCount]) => {
    const distinctTargetBatches = new Set(entries.filter((entry) => entry.word === word).map((entry) => entry.targetBatchIndex)).size;
    return { word, deferredCount, distinctTargetBatches, compliant: distinctTargetBatches >= 2 };
  });
  return { batchId, entries, dispersalCheck: { wordsWithMultipleDeferrals: grouped, allCompliant: grouped.every((item) => item.compliant) } };
}

export function occurrenceKey(occurrence: Occurrence): string { return `${occurrence.word}:${occurrence.senseId}:${occurrence.charStart}`; }