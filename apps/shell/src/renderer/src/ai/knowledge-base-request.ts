import type { KbFileInfo } from '@genoffice/agent-core'
import { applyChatModel, type AiSettings } from '@genoffice/ai-provider/browser'

/** Capture fresh corpus and model settings together before a knowledge-base model request. */
export async function loadKnowledgeBaseRequest(
  api: { getAiSettings(): Promise<AiSettings>; kbList(): Promise<KbFileInfo[]> },
  modelId: string,
) {
  const [rawSettings, files] = await Promise.all([api.getAiSettings(), api.kbList()])
  const settings = structuredClone(applyChatModel(rawSettings, modelId))
  const corpus = files.map((file) => ({ ...file }))
  const corpusKey = JSON.stringify(
    corpus
      .map((file) => [file.path, file.sizeBytes, file.mtimeMs ?? null])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  )
  return { settings, corpus, corpusKey }
}
