import type { Session, OnBeforeRequestListenerDetails } from 'electron'

type Policy = (request: OnBeforeRequestListenerDetails) => boolean
const sessions = new WeakMap<Session, Map<string, Policy>>()

/** Electron allows one request listener per session. Compose policies rather than
 * replacing another feature's access checks when an editor opens. */
export function registerSessionNetworkPolicy(session: Session, name: string, policy: Policy): void {
  let rules = sessions.get(session)
  if (!rules) {
    rules = new Map()
    sessions.set(session, rules)
    const active = rules
    session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (request, reply) => {
        try {
          reply({ cancel: ![...active.values()].every((rule) => rule(request)) })
        } catch {
          reply({ cancel: true })
        }
      },
    )
  }
  rules.set(name, policy)
}
