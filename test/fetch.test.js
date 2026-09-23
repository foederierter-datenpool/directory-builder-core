import { AbortError, fetchOk, pool, retry } from "../src/fetch/index.js"
import { strict as assert } from "assert"
import { test } from "node:test"
import http from "http"

// Retries are real waits, so every test here uses minTimeout 1 and jitter off —
// the backoff curve itself is p-retry's contract, not ours.
const FAST = { minTimeout: 1, jitter: false }

test("retry returns the first successful attempt without retrying", async () => {
    let calls = 0
    const value = await retry(async () => { calls++; return "ok" }, FAST)
    assert.equal(value, "ok")
    assert.equal(calls, 1)
})

test("retry survives transient failures and returns the eventual success", async () => {
    let calls = 0
    const value = await retry(async () => {
        calls++
        if (calls < 3) throw new Error("flaky")
        return "recovered"
    }, FAST)
    assert.equal(value, "recovered")
    assert.equal(calls, 3)
})

test("retry gives up after `attempts` tries and rethrows", async () => {
    let calls = 0
    await assert.rejects(
        () => retry(async () => { calls++; throw new Error("always") }, { ...FAST, attempts: 4 }),
        /always/)
    assert.equal(calls, 4, "attempts counts tries, not retries")
})

test("retry stops immediately on an AbortError", async () => {
    let calls = 0
    await assert.rejects(
        () => retry(async () => { calls++; throw new AbortError(new Error("404")) }, FAST),
        /404/)
    assert.equal(calls, 1, "a failure that cannot succeed must not be retried")
})

test("pool never exceeds its concurrency and keeps results index-aligned", async () => {
    let active = 0, peak = 0
    const items = [...Array(20).keys()]
    const { results, errors } = await pool(items, async (n) => {
        active++; peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return n * 2
    }, { concurrency: 3, retry: FAST })
    assert.equal(peak, 3)
    assert.deepEqual(results, items.map((n) => n * 2))
    assert.deepEqual(errors, [])
})

test("pool retries a flaky item rather than failing the run", async () => {
    const seen = new Map()
    const { results, errors } = await pool(["a", "b", "c"], async (item) => {
        const n = (seen.get(item) ?? 0) + 1
        seen.set(item, n)
        if (item === "b" && n < 3) throw new Error("flaky")
        return item.toUpperCase()
    }, { concurrency: 2, retry: FAST })
    assert.deepEqual(results, ["A", "B", "C"])
    assert.deepEqual(errors, [])
    assert.equal(seen.get("b"), 3)
})

test("pool rejects the whole run on a persistent failure by default", async () => {
    await assert.rejects(() => pool([1, 2, 3], async (n) => {
        if (n === 2) throw new Error("broken")
        return n
    }, { concurrency: 1, retry: { ...FAST, attempts: 2 } }), /broken/)
})

test("stopOnError false reports the gap instead of discarding the harvest", async () => {
    const { results, errors } = await pool([1, 2, 3], async (n) => {
        if (n === 2) throw new Error("broken")
        return n * 10
    }, { concurrency: 1, stopOnError: false, retry: { ...FAST, attempts: 2 } })
    assert.deepEqual(results, [10, undefined, 30], "failed slots stay index-aligned")
    assert.equal(errors.length, 1)
    assert.equal(errors[0].item, 2)
    assert.equal(errors[0].index, 1)
    assert.match(errors[0].error.message, /broken/)
})

test("pool reports progress once per item", async () => {
    const seen = []
    await pool([1, 2, 3], async (n) => n, {
        concurrency: 1, retry: FAST,
        onProgress: ({ completed, total }) => seen.push(`${completed}/${total}`),
    })
    assert.deepEqual(seen, ["1/3", "2/3", "3/3"])
})

// --- fetchOk: a real loopback server, so the status handling is not mocked ----

const serve = async (handler) => {
    const server = http.createServer(handler)
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    const { port } = server.address()
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
}

test("fetchOk returns the response when the status is ok", async () => {
    const s = await serve((_, res) => { res.writeHead(200); res.end("content") })
    try {
        assert.equal(await (await fetchOk(s.url)).text(), "content")
    } finally { await s.close() }
})

test("fetchOk throws on a server error instead of returning the body", async () => {
    const s = await serve((_, res) => { res.writeHead(500); res.end("upstream exploded") })
    try {
        await assert.rejects(() => fetchOk(s.url), (e) => {
            assert.equal(e.status, 500)
            assert.match(e.message, /upstream exploded/, "the body explains the failure")
            assert.ok(!(e instanceof AbortError), "5xx is worth retrying")
            return true
        })
    } finally { await s.close() }
})

test("fetchOk aborts without retrying on a 404", async () => {
    const s = await serve((_, res) => { res.writeHead(404); res.end("nope") })
    let calls = 0
    try {
        await assert.rejects(() => retry(async () => { calls++; return fetchOk(s.url) }, FAST), /404/)
        assert.equal(calls, 1, "a 404 will not come good on attempt two")
    } finally { await s.close() }
})

test("fetchOk retries a 429 rather than aborting", async () => {
    let hits = 0
    const s = await serve((_, res) => {
        hits++
        if (hits < 3) { res.writeHead(429); res.end("slow down") }
        else { res.writeHead(200); res.end("fine") }
    })
    try {
        const body = await retry(() => fetchOk(s.url).then((r) => r.text()), FAST)
        assert.equal(body, "fine")
        assert.equal(hits, 3)
    } finally { await s.close() }
})
