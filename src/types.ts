export type Level = "A2" | "B1" | "B2" | "C1";
export type ExamTarget = "CET4" | "CET6" | "考研" | "雅思" | "托福" | "GRE" | "通用";
export type LengthPreference = "short" | "medium" | "long";
export type Verdict = "covered" | "wrong_sense" | "ambiguous" | "not_found";

export interface BatchInput {
  batchId: string; batchIndex: number; rawInput: string[]; words: string[];
  dropped: Array<{ token: string; reason: "non-english" | "empty" | "duplicate" | "no-sense-data" }>;
  learnerLevel: Level; examTarget: ExamTarget; lengthPreference: LengthPreference; createdAt: string;
}
export interface Sense {
  senseId: string; word: string; pos: string; zhDef: string; enDef: string;
  collocations: string[]; examFreq?: "high" | "medium" | "low"; note?: string;
  surfaceForms?: string[]; provider: string; fetchedAt: string; rankReason?: string; phonetic?: string;
}
export interface Occurrence {
  word: string; surfaceForm: string; charStart: number; charEnd: number;
  senseId: string; sentenceIndex: number; contextSnippet: string;
}
export interface GenerationResult {
  batchId: string; sceneText: string; sceneTitle: string; sceneTitleZh: string; sceneSummaryZh: string;
  wordCount: number; occurrences: Occurrence[];
  uncovered: Array<{ word: string; senseId: string; reason: string }>;
  continuity: { plotSummary: string; characters: string[]; setting: string };
  generationMeta: { model: string; attempt: number; promptVersion: string; latencyMs: number };
}
export interface Judgment { senseId: string; sourceSenseId?: string; word: string; charStart: number; verdict: Verdict; confidence: number; reason: string }
export interface CheckFailure { occurrenceIndex?: number; word?: string; senseId?: string; expected: string; actual: string }
export interface VerificationReport {
  batchId: string; attempt: number;
  positional: { passed: boolean; checks: Array<{ code: `V-0${number}`; passed: boolean; failures: CheckFailure[] }> };
  narrative: { passed: boolean; languagePassed: boolean; confidence: number; causalChain: string[]; issues: string[]; languageIssues: string[]; correction: string };
  semantic: { judgments: Judgment[]; coveredCount: number; targetCount: number; coverageRate: number; lowConfidenceCount: number };
  accepted: boolean; rejectReasons: string[];
}
export interface DeferralPlan {
  batchId: string;
  entries: Array<{ word: string; senseId: string; reason: "capacity" | Verdict | "low_confidence" | "batch_reduced"; targetBatchIndex: number; rationale: string; dispersalNote?: string }>;
  dispersalCheck: { wordsWithMultipleDeferrals: Array<{ word: string; deferredCount: number; distinctTargetBatches: number; compliant: boolean }>; allCompliant: boolean };
}
export interface SenseCoverage {
  word: string; senseId: string; status: "covered" | "deferred" | "pending"; firstCoveredBatch?: number;
  occurrences: Array<{ batchIndex: number; sceneTitle: string; contextSnippet: string; senseZhDef: string }>;
  distinctSceneCount: number; lastUpdated: string;
}
export interface StoredBatch {
  batch: BatchInput; senses: Sense[]; scene: GenerationResult; report: VerificationReport;
  deferrals: DeferralPlan; degradation: string | null; drills: Drill[];
}
export interface Drill { drillId: string; word: string; senseId: string; prompt: string; kind: "学习" | "预习/复习" }
export interface Capacity { maxSceneWords: number; maxInstances: number; naturalInstances: number; perWordCap: number; feasible: boolean }