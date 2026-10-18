import { expect, it, vi } from 'vitest'
import type { Session, OnBeforeRequestListenerDetails } from 'electron'
import { registerSessionNetworkPolicy } from '../src/session-network-policy'

it('composes editor guards on the same session and fails closed', () => {
  const onBeforeRequest = vi.fn()
  const session = { webRequest: { onBeforeRequest } } as unknown as Session
  registerSessionNetworkPolicy(session, 'directory', (request) => request.webContentsId !== 1)
  registerSessionNetworkPolicy(session, 'html', (request) => request.webContentsId !== 2)
  expect(onBeforeRequest).toHaveBeenCalledTimes(1)
  const check = (webContentsId: number) => {
    const reply = vi.fn()
    onBeforeRequest.mock.calls[0]![1]({ webContentsId } as OnBeforeRequestListenerDetails, reply)
    return reply.mock.calls[0]![0]
  }
  expect(check(1)).toEqual({ cancel: true })
  expect(check(2)).toEqual({ cancel: true })
  expect(check(3)).toEqual({ cancel: false })
  registerSessionNetworkPolicy(session, 'html', () => true)
  expect(check(1)).toEqual({ cancel: true })
  expect(check(2)).toEqual({ cancel: false })
  registerSessionNetworkPolicy(session, 'html', () => {
    throw new Error('missing owner')
  })
  expect(check(3)).toEqual({ cancel: true })
})
