import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import { computeCapacity, computeEffectiveLengthRange, normalizeBatch, reconcileGeneration, scheduleDeferrals, verifyPosition } from "../src/core.js";
import { summarizeSemantic, verificationScore, verifiedSenseIds } from "../src/pipeline.js";
import type { GenerationResult, Sense, VerificationReport } from "../src/types.js";

const options = { learnerLevel: "B1" as const, examTarget: "通用" as const, lengthPreference: "short" as const };
const senses: Sense[] = [{ senseId: "alpha-1", word: "alpha", pos: "n.", zhDef: "测试", enDef: "test", collocations: ["alpha one", "alpha two"], provider: "test", fetchedAt: "2026-01-01" }];
const base = (text = "alpha ".repeat(160).trim() + "."): GenerationResult => ({ batchId: "b", sceneText: text, sceneTitle: "t", sceneTitleZh: "t", sceneSummaryZh: "s", wordCount: 160, occurrences: [{ word: "alpha", surfaceForm: "alpha", charStart: 0, charEnd: 5, senseId: "alpha-1", sentenceIndex: 0, contextSnippet: text }], uncovered: [], continuity: { plotSummary: "", characters: [], setting: "" }, generationMeta: { model: "test", attempt: 1, promptVersion: "1", latencyMs: 1 } });

test("normalization removes duplicates and rejects non-English tokens", () => {
  const batch = normalizeBatch("Alpha, alpha, 苹果, beta", 1, options);
  assert.deepEqual(batch.words, ["alpha", "beta"]);
  assert.equal(batch.dropped.filter((item) => item.reason === "duplicate").length, 1);
  assert.equal(batch.dropped.filter((item) => item.reason === "non-english").length, 1);
});

test("normalization treats phrases as exact entries", () => {
  const batch = normalizeBatch("pass over, pass\ntake off", 1, options);
  assert.deepEqual(batch.words, ["pass over", "pass", "take off"]);
});

test("capacity grows with scene length", () => {
  const short = computeCapacity("short", 3, config);
  const long = computeCapacity("long", 3, config);
  assert.ok(long.maxInstances > short.maxInstances);
  assert.ok(long.naturalInstances > short.naturalInstances);
  assert.ok(long.naturalInstances < long.maxInstances);
  assert.equal(computeCapacity("short", 31, config).feasible, false);
  assert.equal(computeCapacity("medium", 3, config).naturalInstances, 6);
});

test("minimum scene length scales with selected targets", () => {
  assert.deepEqual(computeEffectiveLengthRange("medium", 8, config), { min: 160, max: 400 });
  assert.deepEqual(computeEffectiveLengthRange("medium", 20, config), { min: 250, max: 400 });
});

for (const [name, mutate, code] of [
  ["V-01", (r: GenerationResult) => r.occurrences[0].charStart++, "V-01"],
  ["V-05", (r: GenerationResult) => r.wordCount = 10, "V-05"],
  ["V-06", (r: GenerationResult) => r.occurrences = [], "V-06"],
  ["V-07", (r: GenerationResult) => r.occurrences.push({ ...r.occurrences[0], charStart: 1, charEnd: 5, surfaceForm: "lpha" }), "V-07"],
] as const) test(`${name} failure path`, () => {
  const result = base(); mutate(result);
  const report = verifyPosition(result, normalizeBatch(["alpha"], 1, options), senses, config.sceneLength.short, config);
  assert.equal(report.checks.find((check) => check.code === code)?.passed, false);
});

test("deferrals for one word are dispersed across batches", () => {
  const plan = scheduleDeferrals("b", 1, [1, 2, 3].map((number) => ({ word: "alpha", senseId: `alpha-${number}`, reason: "capacity" as const })), config);
  assert.equal(plan.dispersalCheck.allCompliant, true);
  assert.ok(new Set(plan.entries.map((entry) => entry.targetBatchIndex)).size >= 2);
});

test("generation positions and word count are reconciled from final text", () => {
  const result = base("Before alpha, we paused. Then alpha worked.");
  result.wordCount = 99;
  result.occurrences = [
    { word: "alpha", surfaceForm: "alpha", charStart: 0, charEnd: 1, senseId: "alpha-1", sentenceIndex: 9, contextSnippet: "wrong" },
    { word: "alpha", surfaceForm: "alpha", charStart: 30, charEnd: 31, senseId: "alpha-1", sentenceIndex: 9, contextSnippet: "wrong" },
  ];
  const reconciled = reconcileGeneration(result);
  assert.deepEqual(reconciled.occurrences.map((item) => item.charStart), [7, 30]);
  assert.deepEqual(reconciled.occurrences.map((item) => item.sentenceIndex), [0, 1]);
  assert.equal(reconciled.wordCount, 7);
});

test("generation reconciliation never matches inside a longer word", () => {
  const result = base("They are banning it, not using ban today.");
  result.occurrences[0] = { ...result.occurrences[0], word: "ban", surfaceForm: "ban", charStart: 9, charEnd: 12 };
  const reconciled = reconcileGeneration(result);
  assert.equal(reconciled.occurrences[0].charStart, 31);
});

test("best effort scoring keeps unaccepted candidates eligible", () => {
  const report = {
    positional: { passed: false, checks: [] },
    narrative: { passed: false, confidence: 0.6, causalChain: [], issues: [], correction: "" },
    semantic: { judgments: [], coveredCount: 2, targetCount: 4, coverageRate: 0.5, lowConfidenceCount: 0 },
    accepted: false,
  } as unknown as VerificationReport;
  assert.ok(verificationScore(report) > 0);
});

test("best effort scoring prefers language-reviewed text", () => {
  const report = {
    positional: { passed: true, checks: [] },
    narrative: { passed: true, languagePassed: false, confidence: 0.9, causalChain: [], issues: [], languageIssues: ["typo"], correction: "" },
    semantic: { judgments: [], coveredCount: 1, targetCount: 1, coverageRate: 1, lowConfidenceCount: 0 },
    accepted: false,
  } as unknown as VerificationReport;
  const clean = { ...report, narrative: { ...report.narrative, languagePassed: true, languageIssues: [] } };
  assert.ok(verificationScore(clean) > verificationScore(report));
});

test("semantic summary marks every missing target and ignores invented ids", () => {
  const targets = [senses[0], { ...senses[0], senseId: "alpha-2", enDef: "another sense" }];
  const summary = summarizeSemantic(targets, [
    { senseId: "alpha-1", word: "alpha", charStart: 0, verdict: "covered", confidence: 0.9, reason: "matched" },
    { senseId: "invented", word: "alpha", charStart: 6, verdict: "covered", confidence: 0.9, reason: "invalid id" },
  ], config.coverage.confidenceMin);
  assert.equal(summary.coveredCount, 1);
  assert.equal(summary.targetCount, 2);
  assert.equal(summary.coverageRate, 0.5);
  assert.equal(summary.judgments.find((item) => item.senseId === "alpha-2")?.verdict, "not_found");
});

test("learning targets require an exact independent semantic judgment", () => {
  const scene = base("alpha works, but alphabet does not count.");
  scene.occurrences = [
    { ...scene.occurrences[0], charStart: 0, charEnd: 5, contextSnippet: scene.sceneText },
    { ...scene.occurrences[0], charStart: 17, charEnd: 22, contextSnippet: scene.sceneText },
  ];
  const judgments = [{ senseId: "alpha-1", word: "alpha", charStart: 0, verdict: "covered" as const, confidence: 0.99, reason: "matched" }];
  assert.deepEqual([...verifiedSenseIds(scene, senses, judgments)], ["alpha-1"]);
  assert.deepEqual([...verifiedSenseIds(scene, senses, [{ ...judgments[0], charStart: -1, verdict: "not_found" }])], []);
});