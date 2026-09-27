import type { ComponentType, ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@univerjs/ui', () => ({ ComponentManager: class {} }))
import { installMenuInputEnter, wrapWithEnterActivation } from '../src/renderer/menu-input-enter'
import type { UniverRuntime } from '../src/renderer/univer-state'

const key = 'UI_PLUGIN_SHEETS_MENU_ITEM_INPUT_COMPONENT'
function fixture(ready = true) {
  const original = () => null
  const components = new Map<string, ComponentType<Record<string, unknown>>>()
  if (ready) components.set(key, original)
  const manager = {
    get: (name: string) => components.get(name),
    delete: (name: string) => components.delete(name),
    register: vi.fn((name: string, component: ComponentType<Record<string, unknown>>) => {
      if (components.has(name)) throw new Error('Component already exists')
      components.set(name, component)
      return { dispose: () => components.delete(name) }
    }),
  }
  const runtime = {
    univer: { __getInjector: () => ({ get: () => manager }) },
  } as unknown as UniverRuntime
  return { original, components, manager, runtime }
}
afterEach(() => {
  vi.useRealTimers()
})

describe('menu input Enter activation', () => {
  it('replaces the original without duplicate registration, installs once, and restores on cleanup', () => {
    const { original, manager, runtime } = fixture()
    const installed = installMenuInputEnter(runtime)
    expect(manager.get(key)).not.toBe(original)
    expect(installMenuInputEnter(runtime)).toBe(installed)
    expect(manager.register).toHaveBeenCalledTimes(1)
    installed.dispose()
    installed.dispose()
    expect(manager.get(key)).toBe(original)
    expect(manager.register).toHaveBeenCalledTimes(2)
  })

  it('cancels pending installation when its runtime is disposed', () => {
    vi.useFakeTimers()
    const { original, components, manager, runtime } = fixture(false)
    const installed = installMenuInputEnter(runtime)
    installed.dispose()
    components.set(key, original)
    vi.runAllTimers()
    expect(manager.register).not.toHaveBeenCalled()
  })

  it('waits for registration and leaves a later replacement intact on cleanup', () => {
    vi.useFakeTimers()
    const { original, components, manager, runtime } = fixture(false)
    const installed = installMenuInputEnter(runtime)
    components.set(key, original)
    vi.advanceTimersByTime(500)
    expect(manager.get(key)).not.toBe(original)
    const replacement = () => null
    components.set(key, replacement)
    installed.dispose()
    expect(manager.get(key)).toBe(replacement)
  })

  it('activates the row after Enter commits the input, and ignores other keys', () => {
    vi.useFakeTimers()
    const click = vi.fn()
    const Original = () => null
    const element = wrapWithEnterActivation(Original)({ value: 3 }) as ReactElement<{
      onKeyDown: (event: unknown) => void
      children: ReactElement
    }>
    expect(element.props.children.type).toBe(Original)
    const target = { closest: () => ({ click }) }
    element.props.onKeyDown({ key: 'ArrowDown', target })
    vi.runAllTimers()
    expect(click).not.toHaveBeenCalled()
    element.props.onKeyDown({ key: 'Enter', target })
    expect(click).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(click).toHaveBeenCalledTimes(1)
  })
})
