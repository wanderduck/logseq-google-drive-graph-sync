import { describe, expect, it, vi } from 'vitest'
import { createStore } from '../../src/sync/store'

describe('createStore', () => {
  it('returns the initial value and the same reference until it changes', () => {
    const initial = { n: 1 }
    const store = createStore(initial)
    expect(store.get()).toBe(initial)
    expect(store.get()).toBe(store.get())
  })

  it('notifies subscribers synchronously with the new value', () => {
    const store = createStore(1)
    const seen: number[] = []
    store.subscribe((v) => seen.push(v))
    store.set(2)
    store.update((v) => v + 10)
    expect(seen).toEqual([2, 12])
    expect(store.get()).toBe(12)
  })

  it('does not notify when the same value is set again', () => {
    const store = createStore('a')
    const listener = vi.fn()
    store.subscribe(listener)
    store.set('a')
    store.update((v) => v)
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe, even when called during a notification', () => {
    const store = createStore(0)
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = store.subscribe(first)
    store.subscribe(() => offFirst())
    store.subscribe(second)
    store.set(1)
    store.set(2)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })
})
