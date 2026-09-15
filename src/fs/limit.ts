// Bounded-concurrency map for bridge round trips (every `stat`/read is one IPC call). Fails fast: after the
// first rejection no new item starts, the in-flight ones are awaited, then that first error is rethrown.

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`mapLimit: limit must be a positive integer, got ${limit}`)
  const results = new Array<R>(items.length)
  let next = 0
  // An array, not a nullable variable: TS would narrow the latter to `null` across the closure assignments.
  const failures: unknown[] = []

  const worker = async (): Promise<void> => {
    while (failures.length === 0 && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index], index)
      } catch (error) {
        failures.push(error)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failures.length > 0) throw failures[0]
  return results
}
