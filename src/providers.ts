import { z } from "zod";
import { config } from "./config.js";
import { callLlm, currentLlmCacheScope, renderPrompt } from "./llm.js";
import type { Sense } from "./types.js";

const rawSenseSchema = z.object({ pos: z.string(), zhDef: z.string(), enDef: z.string(), collocations: z.array(z.string()).min(2), examFreq: z.enum(["high", "medium", "low"]).optional(), note: z.string().optional(), surfaceForms: z.array(z.string()).optional(), phonetic: z.string().optional() });
const llmSenseSchema = z.object({ senses: z.array(rawSenseSchema).min(1) });
const entryValidationSchema = z.object({ entries: z.array(z.object({ entry: z.string(), normalized: z.string(), valid: z.boolean(), reason: z.string() })) });

export interface SenseProvider { id: string; getSenses(word: string): Promise<Sense[]> }

function finalize(word: string, id: string, values: z.infer<typeof rawSenseSchema>[]): Sense[] {
  const fetchedAt = new Date().toISOString();
  const entryTokens = word.toLowerCase().split(/\s+/);
  const commonValues = values.some((sense) => sense.examFreq !== "low") ? values.filter((sense) => sense.examFreq !== "low") : values;
  return commonValues.map((sense, index) => {
    const surfaceForms = sense.surfaceForms?.filter((form) => {
      const formTokens = form.toLowerCase().trim().split(/\s+/);
      return formTokens.length === entryTokens.length
        && (entryTokens.length === 1 || formTokens.slice(1).every((token, tokenIndex) => token === entryTokens[tokenIndex + 1]));
    });
    return { ...sense, surfaceForms, word, senseId: `${word}-${index + 1}`, provider: id, fetchedAt };
  });
}

export class LlmSenseProvider implements SenseProvider {
  id = "llm";
  async getSenses(word: string): Promise<Sense[]> {
    const prompt = await renderPrompt(config.prompts.senses, { word });
    const { data } = await callLlm(prompt, config.provider.llm.taskTemperature.senses);
    return finalize(word, this.id, llmSenseSchema.parse(data).senses);
  }
}

export class DictionarySenseProvider implements SenseProvider {
  id = "dict-api";
  async getSenses(word: string): Promise<Sense[]> {
    const response = await fetch(`${config.provider.sense.dictionaryEndpoint}/${encodeURIComponent(word)}`);
    if (!response.ok) throw new Error(`词典服务返回 ${response.status}`);
    const entries = await response.json();
    if (!Array.isArray(entries) || !entries.length) return [];
    const source = entries.flatMap((entry: any) => (entry.meanings ?? []).flatMap((meaning: any) => (meaning.definitions ?? []).map((definition: any) => ({ pos: meaning.partOfSpeech, enDef: definition.definition, example: definition.example ?? "" }))));
    if (!source.length) return [];
    const prompt = await renderPrompt(config.prompts.senses, { word, dictionaryData: source });
    const { data } = await callLlm(prompt, config.provider.llm.taskTemperature.senses);
    return finalize(word, this.id, llmSenseSchema.parse(data).senses);
  }
}

const cache = new Map<string, Sense[]>();

export async function validateEntries(entries: string[]) {
  const prompt = await renderPrompt(config.prompts.validateEntries, { entries });
  const { data } = await callLlm(prompt, config.provider.llm.taskTemperature.senses);
  const reviewed = entryValidationSchema.parse(data).entries;
  const byEntry = new Map(reviewed.map((item) => [item.entry.toLowerCase().trim(), item]));
  return entries.map((entry) => byEntry.get(entry.toLowerCase().trim()) ?? { entry, normalized: entry, valid: false, reason: "验证器未返回该词条，按无效处理" });
}

export async function getSenses(words: string[]): Promise<{ senses: Sense[]; unavailable: string[]; trace: string[] }> {
  const trace: string[] = [], unavailable: string[] = [];
  const cacheScope = currentLlmCacheScope();
  const all = await Promise.all(words.map(async (word) => {
    const cacheKey = `${cacheScope}:${word}`;
    if (cache.has(cacheKey)) { trace.push(`${word}: runtime-cache`); return cache.get(cacheKey)!; }
    for (const providerName of config.provider.sense.order) {
      const provider = providerName === "dict-api" ? new DictionarySenseProvider() : new LlmSenseProvider();
      try {
        const senses = await provider.getSenses(word);
        if (senses.length) { cache.set(cacheKey, senses); trace.push(`${word}: ${provider.id}`); return senses; }
      } catch (error) { trace.push(`${word}: ${provider.id} 失败 (${error instanceof Error ? error.message : String(error)})`); }
    }
    unavailable.push(word); return [];
  }));
  return { senses: all.flat(), unavailable, trace };
}