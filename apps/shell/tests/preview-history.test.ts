import { expect, it } from 'vitest'
import {
  completedPreviewHistory,
  interruptPreviewHistory,
} from '../src/renderer/src/ai/preview-history'
import { agentRunCompletion } from '@genoffice/agent-core'
import type { HistoryMessage } from '../src/shared/conversation-api'

function pair(
  outcome: 'completed' | 'cancelled' | 'incomplete' | 'failed',
  hash = 'current',
): HistoryMessage[] {
  return (['user', 'assistant'] as const).map((role, index) => ({
    id: `${role}-1`,
    role,
    text: index ? 'Answer' : 'Question',
    createdAt: 1,
    snapshotHash: hash,
    request: { id: 'request-1', phase: index ? 'final' : 'user', outcome },
  }))
}
it('restores only complete question/answer pairs for the current source snapshot', () => {
  expect(completedPreviewHistory(pair('completed'), 'current')).toEqual([
    { role: 'user', text: 'Question' },
    { role: 'assistant', text: 'Answer' },
  ])
  for (const outcome of ['cancelled', 'incomplete', 'failed'] as const)
    expect(completedPreviewHistory(pair(outcome), 'current')).toEqual([])
  expect(completedPreviewHistory(pair('completed', 'old'), 'current')).toEqual([])
  expect(completedPreviewHistory(pair('completed'))).toEqual([])
  const messages = pair('completed')
  delete messages[1]!.request
  expect(completedPreviewHistory(messages, 'current')).toEqual([])
})
it('marks partial and empty answers explicitly instead of treating them as success', () => {
  const result = { text: 'Answer', cancelled: false, turnLimit: false }
  expect(agentRunCompletion(result)).toEqual({ outcome: 'completed' })
  expect(agentRunCompletion({ ...result, truncated: true })).toEqual({
    outcome: 'incomplete',
    notice: 'outputLimit',
  })
  expect(agentRunCompletion({ ...result, turnLimit: true })).toEqual({
    outcome: 'incomplete',
    notice: 'turnLimit',
  })
  expect(agentRunCompletion({ ...result, cancelled: true })).toEqual({
    outcome: 'cancelled',
    notice: 'stopped',
  })
  expect(agentRunCompletion({ ...result, text: '  ' })).toEqual({
    outcome: 'incomplete',
    notice: 'noReply',
  })
})

it('persists interrupted question/answer pairs as cancelled and excludes them from restored context', () => {
  const previous = pair('completed')
  const pending = pair('completed').map((message) => ({
    ...message,
    id: message.id + '-pending',
    streaming: message.role === 'assistant',
    request: { ...message.request!, id: 'pending', outcome: 'running' as const },
  }))
  const result = interruptPreviewHistory([...previous, ...pending])
  expect(result.slice(0, 2)).toEqual(previous)
  expect(result.slice(2).map((message) => message.request?.outcome)).toEqual([
    'cancelled',
    'cancelled',
  ])
  expect(result[3]).toMatchObject({ streaming: false, error: true })
  expect(completedPreviewHistory(result, 'current')).toHaveLength(2)
})
