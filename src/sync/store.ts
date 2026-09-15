// Minimal observable value store. Pure TS, no host imports. It holds the sync status and the resolved
// settings; React reads it through `useSyncExternalStore` (src/ui/useStore.ts) and the toolbar
// subscribes directly (src/logseq/toolbar.ts).

export type Listener<T> = (value: T) => void

export interface Store<T> {
  /** Current value. The same reference is returned until the value changes. */
  get(): T
  /** Replaces the value. Listeners are not called when `next` is the current value (`Object.is`). */
  set(next: T): void
  update(fn: (current: T) => T): void
  /** Listeners run synchronously after each change. Returns the unsubscribe function. */
  subscribe(listener: Listener<T>): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<Listener<T>>()

  const set = (next: T): void => {
    if (Object.is(next, value)) return
    value = next
    // Copy so a listener that unsubscribes (or subscribes) during notification does not disturb the loop.
    for (const listener of [...listeners]) listener(value)
  }

  return {
    get: () => value,
    set,
    update: (fn) => set(fn(value)),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
