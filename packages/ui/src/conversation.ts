/** Shared turn boundaries. A turn includes its question, answer segments and tool receipts. */
export interface ConversationMessage {
  role: 'user' | 'assistant'
  text: string
}

export function questionIndex(messages: readonly ConversationMessage[], index: number): number {
  if (index < 0 || index >= messages.length) return -1
  while (index >= 0 && messages[index]!.role !== 'user') index--
  return index
}

export function turnEnd(messages: readonly ConversationMessage[], index: number): number {
  const start = questionIndex(messages, index)
  if (start < 0) return -1
  const next = messages.findIndex((message, i) => i > start && message.role === 'user')
  return next < 0 ? messages.length : next
}

/** A tool-assisted reply can have several assistant segments but needs only one action row. */
export function isFinalAnswer<T extends ConversationMessage>(
  messages: readonly T[],
  index: number,
  hasContent: (message: T) => boolean = (message) => !!message.text.trim(),
): boolean {
  const message = messages[index]
  if (!message || message.role !== 'assistant' || !hasContent(message)) return false
  for (let next = index + 1; next < messages.length; next++) {
    const following = messages[next]!
    if (following.role === 'user') break
    if (hasContent(following)) return false
  }
  return true
}

/** Downloads use the same path in every panel; text is never interpolated into HTML. */
export function exportConversation(
  title: string,
  messages: readonly ConversationMessage[],
  format: 'md' | 'json',
  details?: unknown,
): void {
  const value =
    format === 'json'
      ? JSON.stringify({ title, messages, ...(details ? { details } : {}) }, null, 2)
      : `# ${title}\n\n${messages.map((message) => `## ${message.role === 'user' ? 'You' : 'Assistant'}\n\n${message.text}`).join('\n\n')}\n`
  const url = URL.createObjectURL(
    new Blob([value], {
      type: format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8',
    }),
  )
  const link = document.createElement('a')
  link.href = url
  const filename = Array.from(title, (character) =>
    character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character,
  ).join('')
  link.download = `${filename.slice(0, 100) || 'conversation'}.${format}`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
