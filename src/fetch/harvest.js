// Shared fetch primitives — tranche 2: partitioning, paging, two-phase crawls.
//
// Builds on pool/retry (tranche 1) and stays transport-agnostic: fetchOne is a
// plain async callback, so an HTTP request, a scraped page and a browser step
// are all expressible.
import { retry } from "./index.js"

// harvest is an async generator, yielding one result per partition as it
// completes. That is deliberate, and it is the part of the design worth
// arguing with.
//
// The obvious shape — collect every record, return an array — cannot serve the
// source that motivated this work: ~247k records at ~112 KB each is tens of GB,
// and the projection that would cut it by two orders of magnitude happens
// downstream, after the array already exists. Yielding per partition bounds
// memory to one partition's worth and lets the caller write each batch out
// before the next arrives. A caller that genuinely wants everything in memory
// says so, with collect().
//
//     for await (const { partition, items } of harvest({ ... })) { ... }
//     const all = await collect(harvest({ ... }))
//
// Paging is sequential within a partition (page N+1 is only known not to be the
// last once page N returns) and concurrent across partitions.
//
// fetchOne(partition, pageNumber) returns { items, total }:
//   items  the records or documents of this page
//   total  optional, what the source says the whole partition holds. Feeds
//          truncation detection below, and tranche 3's validation.
//
// A source with no partitioning passes no partitions; one with no paging
// returns everything on page 1 and is never asked for page 2.
export async function* harvest({
    partitions = [undefined],
    fetchOne,
    dedupBy,
    concurrency = 3,
    retry: retryOptions,
    delayMs = 0,
    maxPages = 1000,
    onProgress,
} = {}) {
    if (typeof fetchOne !== "function") throw new TypeError("harvest needs a fetchOne(partition, page) callback")
    const list = [...partitions]
    // Dedup spans partitions, which is the whole point: a detail page appears on
    // several listing pages, and the same entry under several postal codes. It
    // has to be applied here rather than by the caller, because the duplicate
    // costs an HTTP request and a JVM at lift, and nothing downstream can undo
    // either. Duplicate *records* are not the target — those collapse in the
    // store when the Turtle is written.
    const seen = dedupBy ? new Set() : null
    let completed = 0

    const onePartition = async (partition) => {
        const items = []
        let total, pages = 0, truncated = false
        for (let page = 1; page <= maxPages; page++) {
            const result = await retry(() => fetchOne(partition, page), retryOptions)
            const batch = result?.items ?? []
            if (result?.total != null) total = result.total
            pages = page
            for (const item of batch) {
                if (seen) {
                    const key = dedupBy(item)
                    if (seen.has(key)) continue
                    seen.add(key)
                }
                items.push(item)
            }
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
            if (!batch.length) {
                // An empty page is the usual end-of-partition signal, but it is
                // also what a capped API returns past its ceiling — the source
                // that prompted this returns HTTP 200 and an empty results[]
                // beyond 10,000, while still reporting the true total. Those are
                // indistinguishable from the page alone; comparing against the
                // reported total tells them apart. Reported here, not thrown:
                // acting on it is validation's job (tranche 3).
                if (total != null && items.length < total) truncated = true
                break
            }
            if (total != null && items.length >= total) break
        }
        return { partition, items, pages, total, truncated }
    }

    // Stream results as they finish rather than gathering them: keeps `concurrency`
    // partitions in flight without waiting for the slowest of each batch, and keeps
    // only in-flight partitions in memory.
    const inFlight = new Map()
    let next = 0
    const start = () => {
        if (next >= list.length) return
        const index = next++
        inFlight.set(index, onePartition(list[index]).then((value) => ({ index, value })))
    }
    while (inFlight.size < concurrency && next < list.length) start()

    while (inFlight.size) {
        const { index, value } = await Promise.race(inFlight.values())
        inFlight.delete(index)
        start()
        completed++
        onProgress?.({ completed, total: list.length, partition: value.partition })
        yield value
    }
}

// Drain a harvest into one flat array of items.
//
// The convenience for sources small enough not to care — most of them. Do not
// reach for it on a source whose corpus does not fit in memory; iterate instead.
export const collect = async (iterable) => {
    const items = []
    for await (const result of iterable) items.push(...result.items)
    return items
}
