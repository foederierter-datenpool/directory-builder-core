import { collect, harvest } from "../src/fetch/index.js"
import { strict as assert } from "assert"
import { test } from "node:test"

const FAST = { minTimeout: 1, jitter: false }

// A paged source: `corpus` per partition, served `pageSize` at a time, reporting
// its own total the way a real API does.
const pagedSource = (corpus, { pageSize = 2, reportTotal = true, cap = Infinity } = {}) =>
    async (partition, page) => {
        const all = corpus[partition] ?? []
        const start = (page - 1) * pageSize
        // Past `cap` the source returns 200 + empty, still reporting the true
        // total — the silent-truncation shape.
        const items = start >= cap ? [] : all.slice(start, start + pageSize)
        return reportTotal ? { items, total: all.length } : { items }
    }

test("harvest pages a single partition to exhaustion", async () => {
    const items = await collect(harvest({
        fetchOne: pagedSource({ undefined: [1, 2, 3, 4, 5] }),
        retry: FAST,
    }))
    assert.deepEqual(items, [1, 2, 3, 4, 5])
})

test("harvest covers every partition and the union is the corpus", async () => {
    const corpus = { a: [1, 2, 3], b: [4, 5], c: [6] }
    const items = await collect(harvest({
        partitions: ["a", "b", "c"],
        fetchOne: pagedSource(corpus),
        concurrency: 2,
        retry: FAST,
    }))
    assert.deepEqual(items.sort((x, y) => x - y), [1, 2, 3, 4, 5, 6])
})

test("harvest yields per partition rather than accumulating the corpus", async () => {
    const seen = []
    for await (const { partition, items } of harvest({
        partitions: ["a", "b"],
        fetchOne: pagedSource({ a: [1, 2, 3], b: [4] }),
        concurrency: 1,
        retry: FAST,
    })) seen.push([partition, items])
    assert.deepEqual(seen, [["a", [1, 2, 3]], ["b", [4]]])
})

test("harvest stops at the reported total without fetching an empty page", async () => {
    let calls = 0
    const items = await collect(harvest({
        fetchOne: async (_p, page) => {
            calls++
            return { items: [1, 2, 3, 4].slice((page - 1) * 2, page * 2), total: 4 }
        },
        retry: FAST,
    }))
    assert.deepEqual(items, [1, 2, 3, 4])
    assert.equal(calls, 2, "a known total means the trailing empty page is unnecessary")
})

test("harvest flags a capped source that reports 200 + empty past its ceiling", async () => {
    const results = []
    for await (const r of harvest({
        fetchOne: pagedSource({ undefined: Array.from({ length: 20 }, (_, i) => i) }, { cap: 6 }),
        retry: FAST,
    })) results.push(r)
    const [only] = results
    assert.equal(only.items.length, 6, "only what the cap allowed through")
    assert.equal(only.total, 20, "while the source still reports the true total")
    assert.equal(only.truncated, true, "and that discrepancy is surfaced, not swallowed")
})

test("harvest does not flag a genuinely exhausted partition", async () => {
    for await (const r of harvest({ fetchOne: pagedSource({ undefined: [1, 2, 3] }), retry: FAST }))
        assert.equal(r.truncated, false)
})

test("harvest cannot flag truncation when the source reports no total", async () => {
    for await (const r of harvest({
        fetchOne: pagedSource({ undefined: [1, 2, 3] }, { reportTotal: false }),
        retry: FAST,
    })) {
        assert.equal(r.truncated, false)
        assert.equal(r.total, undefined, "nothing to compare against — a minRecords floor is the fallback")
    }
})

test("dedupBy collapses the same item discovered under several partitions", async () => {
    // The real shape: one detail page linked from several listing pages.
    const corpus = { a: [{ id: 1 }, { id: 2 }], b: [{ id: 2 }, { id: 3 }], c: [{ id: 1 }, { id: 3 }] }
    const items = await collect(harvest({
        partitions: ["a", "b", "c"],
        fetchOne: pagedSource(corpus, { pageSize: 10 }),
        dedupBy: (item) => item.id,
        concurrency: 1,
        retry: FAST,
    }))
    assert.deepEqual(items.map((i) => i.id).sort(), [1, 2, 3])
})

test("harvest retries a flaky page instead of losing the partition", async () => {
    let attempts = 0
    const items = await collect(harvest({
        fetchOne: async () => {
            attempts++
            if (attempts < 3) throw new Error("flaky")
            return { items: ["ok"], total: 1 }
        },
        retry: FAST,
    }))
    assert.deepEqual(items, ["ok"])
    assert.equal(attempts, 3)
})

test("harvest respects concurrency across partitions", async () => {
    let active = 0, peak = 0
    await collect(harvest({
        partitions: [...Array(9).keys()],
        fetchOne: async () => {
            active++; peak = Math.max(peak, active)
            await new Promise((r) => setTimeout(r, 5))
            active--
            return { items: [1], total: 1 }
        },
        concurrency: 3,
        retry: FAST,
    }))
    assert.equal(peak, 3)
})

test("maxPages stops a source that never returns an empty page", async () => {
    let calls = 0
    const items = await collect(harvest({
        fetchOne: async () => { calls++; return { items: ["endless"] } },
        maxPages: 5,
        retry: FAST,
    }))
    assert.equal(calls, 5)
    assert.equal(items.length, 5)
})

test("a two-phase crawl chains two harvests, the second bounded by the first", async () => {
    // Phase 1: listing pages per partition yield detail URLs, deduped.
    const listings = {
        plz1: [{ url: "/a" }, { url: "/b" }],
        plz2: [{ url: "/b" }, { url: "/c" }],   // /b appears under both
    }
    const urls = await collect(harvest({
        partitions: ["plz1", "plz2"],
        fetchOne: pagedSource(listings, { pageSize: 10 }),
        dedupBy: (item) => item.url,
        retry: FAST,
    }))
    assert.deepEqual(urls.map((u) => u.url).sort(), ["/a", "/b", "/c"])

    // Phase 2: one document per discovered URL — phase 1's output is phase 2's
    // partition list, so the count check becomes structural.
    const pages = await collect(harvest({
        partitions: urls,
        fetchOne: async ({ url }) => ({ items: [`<html>${url}</html>`], total: 1 }),
        concurrency: 2,
        retry: FAST,
    }))
    assert.equal(pages.length, urls.length, "phase 2 must yield exactly one document per URL")
    assert.deepEqual(pages.sort(), ["<html>/a</html>", "<html>/b</html>", "<html>/c</html>"])
})

test("harvest reports progress per completed partition", async () => {
    const seen = []
    await collect(harvest({
        partitions: ["a", "b", "c"],
        fetchOne: pagedSource({ a: [1], b: [2], c: [3] }, { pageSize: 10 }),
        concurrency: 1,
        retry: FAST,
        onProgress: ({ completed, total }) => seen.push(`${completed}/${total}`),
    }))
    assert.deepEqual(seen, ["1/3", "2/3", "3/3"])
})

test("harvest without a fetchOne fails loudly", async () => {
    await assert.rejects(() => collect(harvest({ partitions: ["a"] })), /fetchOne/)
})

// Regression: the prefill loop kept calling start() until `concurrency` slots
// were full, which never happens when there are fewer partitions than slots —
// it spun forever. One partition against the default concurrency of 3 is the
// ordinary case, so this hung almost every caller.
test("harvest terminates when there are fewer partitions than concurrency slots", async () => {
    const items = await collect(harvest({
        partitions: ["only"],
        fetchOne: async () => ({ items: [1], total: 1 }),
        concurrency: 8,
        retry: FAST,
    }))
    assert.deepEqual(items, [1])
})

test("harvest terminates on an empty partition list", async () => {
    assert.deepEqual(await collect(harvest({ partitions: [], fetchOne: async () => ({ items: [1] }) })), [])
})

// Same bug class as the extract stack overflow: collect() appended each
// partition's items with push(...items), so one partition carrying enough of
// them exceeded V8's argument limit. An unpartitioned harvest of a large corpus
// reaches that easily.
test("collect drains a partition too large for a push spread", async () => {
    const BIG = 160_000
    const items = await collect(harvest({
        fetchOne: async (_p, page) => page === 1
            ? { items: Array.from({ length: BIG }, (_, i) => i), total: BIG }
            : { items: [], total: BIG },
        retry: FAST,
    }))
    assert.equal(items.length, BIG)
})

// A development cap. Distinct from truncation: both fall short of the source's
// reported total, and only the caller knows which is which.
test("limit stops the harvest at exactly that many records", async () => {
    const items = await collect(harvest({
        fetchOne: async (_p, page) => ({ items: Array.from({ length: 100 }, (_, i) => (page - 1) * 100 + i), total: 5000 }),
        limit: 250,
        retry: FAST,
    }))
    assert.equal(items.length, 250, "trimmed mid-page, not rounded up to a page boundary")
})

test("a capped run is marked capped and not truncated", async () => {
    for await (const r of harvest({
        fetchOne: async (_p, page) => ({ items: page <= 5 ? [1, 2, 3] : [], total: 999 }),
        limit: 4,
        retry: FAST,
    })) {
        assert.equal(r.capped, true)
        assert.equal(r.truncated, false, "stopping deliberately is not the source truncating us")
    }
})

test("limit stops launching further partitions", async () => {
    let touched = 0
    await collect(harvest({
        partitions: [...Array(50).keys()],
        fetchOne: async () => { touched++; return { items: [1, 2], total: 2 } },
        limit: 4,
        concurrency: 1,
        retry: FAST,
    }))
    assert.ok(touched <= 3, `stopped early, touched ${touched} of 50 partitions`)
})

test("an uncapped harvest is unaffected", async () => {
    for await (const r of harvest({
        fetchOne: async (_p, page) => ({ items: page === 1 ? [1, 2, 3] : [], total: 3 }),
        retry: FAST,
    })) assert.equal(r.capped, false)
})
