/** 单个任务的收敛结果：永不 reject，失败也只以 reason 形式返回 */
export type Settled<R> = { ok: true; value: R } | { ok: false; reason: unknown }

/**
 * 以固定并发度跑完一组任务，结果按输入顺序返回。
 *
 * 为什么不用现成的 `Promise.allSettled(items.map(worker))`：
 * 那样会**一次性把所有任务都启动**。模型若一次返回十几个 fetch_url，
 * 就是同时开十几条对外连接——在 256MB、出站带宽受限的云函数实例里，
 * 这属于把可控的串行拖成不可控的并发尖峰。这里用 N 个 worker 抢任务号，
 * 并发度封顶，同时保留 allSettled 的"单个失败不影响整体"语义。
 *
 * 顺序保证：结果写入按 index 预分配的槽位，与完成先后无关，
 * 因此回填给上游的 tool 消息顺序能和 tool_calls 一致。
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<Settled<R>>> {
  const results = new Array<Settled<R>>(items.length)
  if (!items.length) {
    return results
  }

  const poolSize = Math.max(1, Math.min(limit, items.length))
  let cursor = 0

  const lane = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      try {
        results[index] = { ok: true, value: await worker(items[index], index) }
      } catch (error) {
        results[index] = { ok: false, reason: error }
      }
    }
  }

  await Promise.all(Array.from({ length: poolSize }, lane))
  return results
}
