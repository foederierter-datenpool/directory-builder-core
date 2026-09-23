// Shared fetch primitives — tranche 1: concurrency and retry.
//
// Fetchers live in instance repos and run as their own process (the fetch step
// shells out to sources/<name>/fetch.js), so nothing here is wired into the
// engine: a fetcher opts in by importing it, and one that doesn't is unaffected.
//
//     import { pool, retry, fetchOk } from "@directory-builder/core/fetch"
//
// Deliberately transport-agnostic. `worker` is a plain async callback, so it
// covers an HTTP request, a scraped page or a browser step equally — one source
// across the federations drives Playwright rather than making requests, which an
// HTTP client as the core abstraction would exclude. fetchOk is the one
// HTTP-specific helper and is optional.
//
// Not here yet, by design: partitioning, paging, validation, projection and
// chunking. Those need the harvest/emit shape settled first (see the proposal
// issue) — this tranche is the part that needs no config and no format knowledge.
import pMap from "p-map"
import pRetry, { AbortError } from "p-retry"

export { AbortError }
export { harvest, collect } from "./harvest.js"
export { emit, RECORD_CLASS, RECORD_SELECTOR } from "./emit.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Retry an async operation with exponential backoff and full jitter.
//
// Jitter matters more than the backoff curve when a pool of N workers hits the
// same host: without it every worker's attempt lands in the same instant and the
// retries themselves become the burst that keeps failing. Full jitter spreads
// each delay over [0, computed), which is why it's on by default.
//
// Throw an AbortError from `fn` to stop retrying immediately — for a failure
// that cannot succeed on a second attempt (a 404, a contract violation), where
// retrying only multiplies load.
export const retry = async (fn, {
    attempts = 5,
    minTimeout = 1000,
    maxTimeout = 30_000,
    factor = 2,
    jitter = true,
    onFailedAttempt,
} = {}) => pRetry(fn, {
    retries: Math.max(0, attempts - 1),   // p-retry counts retries; `attempts` counts tries
    minTimeout,
    maxTimeout,
    factor,
    randomize: false,   // p-retry's randomize is a 1–2x multiplier, not full jitter
    onFailedAttempt: async (error) => {
        await onFailedAttempt?.(error)
        if (!jitter || error.retriesLeft === 0) return
        // Full jitter on top of p-retry's own wait: sleep an extra random slice
        // of the same window, so concurrent workers desynchronise.
        const window = Math.min(minTimeout * factor ** (error.attemptNumber - 1), maxTimeout)
        await sleep(Math.random() * window)
    },
})

// Run `worker` over `items` with bounded concurrency, retrying each item.
//
// Returns { results, errors }. `results` is index-aligned with `items`, holding
// undefined where an item failed; `errors` holds { item, index, error }.
//
// stopOnError defaults to true: one item that fails every attempt rejects the
// whole call. That is the existing behaviour of the hand-rolled pools this
// replaces, and it stays the default deliberately — a partial harvest that
// nobody notices is the more dangerous failure, and nothing validates harvest
// volume yet. Pass stopOnError: false to tolerate gaps, and check `errors`.
//
// delayMs is a politeness pause after each item, per worker slot — the sleep(100)
// that every fetcher currently hand-rolls.
export const pool = async (items, worker, {
    concurrency = 3,
    retry: retryOptions,
    stopOnError = true,
    delayMs = 0,
    onProgress,
} = {}) => {
    const list = [...items]
    const errors = []
    let completed = 0

    const results = await pMap(list, async (item, index) => {
        try {
            const value = await retry(() => worker(item, index), retryOptions)
            return value
        } catch (error) {
            errors.push({ item, index, error })
            if (stopOnError) throw error
            return undefined
        } finally {
            completed++
            onProgress?.({ completed, total: list.length })
            if (delayMs) await sleep(delayMs)
        }
    }, { concurrency, stopOnError })

    return { results, errors }
}

// fetch that treats a non-OK status as an error instead of a body.
//
// The gap this closes is real: the largest scrape in any instance repo writes
// whatever comes back straight to disk without checking, so a 500 or a bot
// challenge page is lifted as though it were content. A status check belongs at
// the transport edge, not in each author's convention.
//
// 4xx aborts without retrying (AbortError) — a 404 or a 403 will not come good
// on attempt two. 5xx and 429 throw an ordinary error, so `retry` backs off.
export const fetchOk = async (url, init) => {
    const response = await fetch(url, init)
    if (response.ok) return response
    // Body first: the reason a request failed is usually in it, and it is
    // unreadable once the response is discarded.
    const snippet = (await response.text().catch(() => "")).slice(0, 200)
    const error = new Error(`${response.status} ${response.statusText} for ${url}${snippet ? ` — ${snippet}` : ""}`)
    error.status = response.status
    error.url = url
    throw (response.status >= 400 && response.status < 500 && response.status !== 429)
        ? new AbortError(error)
        : error
}
