import { useSyncExternalStore } from 'react'
import type { Store } from '../sync/store'

/** Subscribes a component to a `Store`; re-renders on every change. */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get)
}
