import type { AiProviderId } from './types'

/** Browser-safe defaults shared by the endpoint registry and per-model policies. */
export const AI_PROVIDER_VISION: Record<AiProviderId, boolean> = {
  genspark: true,
  codex: true,
  anthropic: true,
  gemini: true,
  deepseek: true,
  openai: true,
  kimi: true,
  glm: false,
  qwen: false,
  doubao: true,
  mimo: true,
  hunyuan: false,
  ling: true,
  spark: false,
  longcat: true,
  minimax: true,
  xai: true,
  mistral: false,
  openrouter: true,
  requesty: true,
  opper: true,
  cheaperinference: true,
  atlascloud: true,
  'opencode-zen': true,
  'opencode-go': true,
  custom: false,
}

/** Model routes that reject images even when their provider accepts them. */
export function modelLacksVision(model: string): boolean {
  // MiniMax-M2.7 remains text-only when MiniMax-M3 enables direct API vision.
  if (/(^|\/)minimax-m2\.7($|-)/i.test(model)) return true
  // Atlas Cloud serves these namespaced routes as text-only; MiniMax M3 on
  // MiniMax's own API, and the gateway's GLM-5.3-Flash route, still take images.
  if (/^(?:zai-org\/glm-5\.3|minimaxai\/minimax-m(?:3|2\.5))$/i.test(model)) return true
  return (
    /(^|\/)deep-?seek-v4-(?:pro(?:$|-)|flash(?!-vision))/i.test(model) ||
    /(^|\/)(?:ling-(?:3\.0-flash(?!-vl)|3\.0-tiny|2\.6-1t|2\.6-flash)|ring-2\.6-1t|longcat-2\.0(?:$|-))/i.test(
      model,
    )
  )
}
