import type { AgentMessage } from '@genoffice/agent-core'
import type { HistoryMessage } from '../../../shared/conversation-api'

/** A stopped or detached run must never remain a resumable streaming turn. */
export function interruptPreviewHistory(messages: readonly HistoryMessage[]): HistoryMessage[] {
  return messages.map((message) =>
    message.request?.outcome === 'running'
      ? {
          ...message,
          streaming: false,
          ...(message.role === 'assistant' ? { error: true } : {}),
          request: { ...message.request, outcome: 'cancelled' },
        }
      : message.streaming
        ? { ...message, streaming: false }
        : message,
  )
}

/** Only successful question/answer pairs about this exact file snapshot are model context. */
export function completedPreviewHistory(
  messages: readonly HistoryMessage[],
  sourceHash?: string,
): AgentMessage[] {
  const result: AgentMessage[] = []
  for (let i = 0; i + 1 < messages.length; i++) {
    const question = messages[i]!,
      answer = messages[i + 1]!
    if (
      question.role !== 'user' ||
      answer.role !== 'assistant' ||
      !sourceHash ||
      question.snapshotHash !== sourceHash ||
      answer.snapshotHash !== sourceHash ||
      !question.request ||
      question.request.id !== answer.request?.id ||
      question.request.phase !== 'user' ||
      answer.request.phase !== 'final' ||
      question.request.outcome !== 'completed' ||
      answer.request.outcome !== 'completed' ||
      answer.error ||
      answer.streaming ||
      !answer.text.trim()
    )
      continue
    result.push({ role: 'user', text: question.text }, { role: 'assistant', text: answer.text })
    i++
  }
  return result
}
