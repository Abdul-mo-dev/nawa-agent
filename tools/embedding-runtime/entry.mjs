import { env, pipeline as createPipeline } from '@huggingface/transformers'

export { env }
/** Nawa's local knowledge model accepts text feature extraction only. */
export function pipeline(task, ...args) {
  if (task !== 'feature-extraction')
    throw new Error('The native embedding runtime accepts text only.')
  return createPipeline(task, ...args)
}
