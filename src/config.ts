import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 4173),
  batchSize: { default: 10, min: 3, max: 20 },
  learnerLevel: { default: "B1" as const },
  sceneLength: {
    short: { min: 150, max: 250 },
    medium: { min: 250, max: 400 },
    long: { min: 400, max: 600 },
  },
  capacity: {
    instanceDensity: 0.12,
    perWordShareFactor: 1.3,
    narrativeWordsPerInstance: 60,
    minimumWordsPerInstance: 20,
    minimumSceneWords: 120,
  },
  coverage: { threshold: 1, confidenceMin: 0.7, coherenceMin: 0.75 },
  verify: {
    lengthTolerance: 0.1,
    markerPatterns: ["**", "__", "[[", "{{", "<mark"],
  },
  generation: { maxRetries: 3, semanticConcurrency: 5 },
  schedule: {
    minBatchGap: 1,
    sortWeights: { examFrequency: 4, commonness: 3, unseen: 5, concrete: 1 },
  },
  provider: {
    sense: { order: ["dict-api", "llm"] as const, dictionaryEndpoint: "https://api.dictionaryapi.dev/api/v2/entries/en" },
    llm: {
      endpoint: process.env.LLM_BASE_URL ?? "",
      model: process.env.LLM_MODEL ?? "",
      apiKey: process.env.LLM_API_KEY ?? "",
      maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 16384),
      jsonAttempts: 2,
      thinking: process.env.LLM_THINKING === "true",
      temperature: 0.7,
      taskTemperature: { senses: 0.2, verifier: 0, coherence: 0, drill: 0.8 },
    },
    sensitiveWordsUrl: process.env.SENSITIVE_WORDS_URL ?? "",
  },
  prompts: {
    validateEntries: "prompts/validate-entries.txt",
    scene: "prompts/scene.txt",
    judgeSense: "prompts/judge-sense.txt",
    judgeDrill: "prompts/judge-drill.txt",
    judgeCoherence: "prompts/judge-coherence.txt",
    drill: "prompts/drill.txt",
    summarize: "prompts/summarize.txt",
    senses: "prompts/senses.txt",
  },
} as const;

export type AppConfig = typeof config;