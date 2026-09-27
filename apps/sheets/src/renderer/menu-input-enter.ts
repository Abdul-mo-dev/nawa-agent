/**
 * Enter in a right-click menu count box must run the row's action.
 *
 * Univer's context-menu number rows ("insert N columns left/right", "insert
 * N rows", column width / row height) use its MenuItemInput label component,
 * whose Enter handler only commits the typed number — the menu stays open
 * and nothing happens until the user separately clicks the row, so Enter
 * looks dead (user report: typed a count into "Insert N columns left" and pressed
 * Enter to no effect). Excel executes on Enter.
 *
 * Replace the registered component
 * with a wrapper that, after the input commits, activates the enclosing
 * menu-row <button> — the exact code path a mouse click takes, so command,
 * value plumbing, and menu dismissal all stay upstream's.
 */
import { createElement } from 'react'
import type { ComponentType, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { ComponentManager } from '@univerjs/ui'
import type { IDisposable } from '@univerjs/core'

import type { UniverRuntime } from './univer-state'

/** sheets-ui's MENU_ITEM_INPUT_COMPONENT key — the constant is not exported */
const MENU_ITEM_INPUT_COMPONENT = 'UI_PLUGIN_SHEETS_MENU_ITEM_INPUT_COMPONENT'

/** sheets-ui registers the component during its own lifecycle — poll briefly */
const INSTALL_RETRIES = 20
const INSTALL_RETRY_MS = 500
const installations = new WeakMap<ComponentManager, IDisposable>()

export function wrapWithEnterActivation(
  Original: ComponentType<Record<string, unknown>>,
): (props: Record<string, unknown>) => ReactElement {
  return function MenuItemInputWithEnter(props: Record<string, unknown>): ReactElement {
    return createElement(
      'div',
      {
        // display:contents keeps the row's flex layout untouched while the
        // div still sees the input's bubbled keydown
        style: { display: 'contents' },
        onKeyDown: (event: ReactKeyboardEvent) => {
          if (event.key !== 'Enter') return
          const row = (event.target as HTMLElement).closest('button')
          // next tick: let the commit re-render land before the click reads it
          if (row) setTimeout(() => row.click(), 0)
        },
      },
      createElement(Original, props),
    )
  }
}

export function installMenuInputEnter(runtime: UniverRuntime): IDisposable {
  const componentManager = runtime.univer.__getInjector().get(ComponentManager)
  const installed = installations.get(componentManager)
  if (installed) return installed
  let timer: ReturnType<typeof setTimeout> | undefined
  let restore: (() => void) | undefined
  let disposed = false
  const disposable = {
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(timer)
      restore?.()
      installations.delete(componentManager)
    },
  }
  installations.set(componentManager, disposable)
  const attempt = (retries: number): void => {
    if (disposed) return
    const original = componentManager.get(MENU_ITEM_INPUT_COMPONENT) as
      ComponentType<Record<string, unknown>> | undefined
    if (!original) {
      if (retries > 0) timer = setTimeout(() => attempt(retries - 1), INSTALL_RETRY_MS)
      return
    }
    const wrapped = wrapWithEnterActivation(original)
    componentManager.delete(MENU_ITEM_INPUT_COMPONENT)
    const registration = componentManager.register(MENU_ITEM_INPUT_COMPONENT, wrapped)
    restore = () => {
      if (componentManager.get(MENU_ITEM_INPUT_COMPONENT) !== wrapped) return
      registration.dispose()
      componentManager.register(MENU_ITEM_INPUT_COMPONENT, original)
    }
  }
  attempt(INSTALL_RETRIES)
  return disposable
}
