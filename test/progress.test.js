import { scorePairs } from "../src/pipeline/steps/match.js"
import { token_set_ratio } from "fuzzball"
import assert from "node:assert/strict"
import { test } from "node:test"

// Progress exists so a long step can be told from a hung one. These assert it
// is reported at all and that the figure is the comparison count across the
// whole rule — not per worker, which would look like the run going backwards.

const build = (n) => {
    const subjects = Array.from({ length: n }, (_, i) => `urn:s:${i}`)
    const topic = (i) => ["Kultur", "Bildung", "Sport", "Umwelt"][i % 4]
    const names = subjects.map((_, i) => `Programm ${i} ${topic(i)} ${i * 7919 % 100000}`)
    const hardVals = new Map(subjects.map((s) => [s, [null]]))
    const weightedVals = new Map(subjects.map((s, i) => [s, [names[i]]]))
    const sourceOf = new Map(subjects.map((s, i) => [s, i % 2 ? "urn:a" : "urn:b"]))
    return {
        subjects, hardVals, weightedVals, sourceOf,
        dedupsWithin: () => true,
        hard: [{ optional: true }],
        weighted: [{ pred: { value: "urn:p" }, weight: 1, minSim: null }],
        minScore: 0.99, algoName: "token_set_ratio",
        score: (a, b) => {
            const sim = token_set_ratio(weightedVals.get(a)[0], weightedVals.get(b)[0]) / 100
            return sim < 0.99 ? null : { scores: [], aggregate: sim }
        },
    }
}

test("in-process scoring reports comparisons against the total", async () => {
    const base = build(120)                       // 7,140 pairs
    const units = [{ members: base.subjects }]
    const pairCount = 120 * 119 / 2
    const seen = []
    await scorePairs({ ...base, units, pairCount, workers: 1,
        progressMask: 0x3FF,                      // every 1,024 comparisons
        onProgress: (done, total) => seen.push([done, total]) })

    assert.ok(seen.length >= 5, `reported repeatedly, got ${seen.length}`)
    assert.ok(seen.every(([, total]) => total === pairCount), "total is the rule's pair count")
    assert.deepEqual(seen.map(([d]) => d), [...seen.map(([d]) => d)].sort((a, b) => a - b),
        "counts only go up")
    assert.ok(seen.at(-1)[0] <= pairCount, "never reports more than it will do")
})

test("worker scoring reports the sum across workers, not each worker's own count", async () => {
    // Per-worker counts would look like the run going backwards as messages
    // interleave; the parent sums them.
    const base = build(200)
    const units = base.subjects.map((s, i) => ({ members: base.subjects.slice(i, i + 40) }))
    const pairCount = units.reduce((n, u) => n + u.members.length * (u.members.length - 1) / 2, 0)
    const seen = []
    await scorePairs({ ...base, units, pairCount, workers: 3, threshold: 0,
        progressMask: 0x1FF,
        onProgress: (done) => seen.push(done) })

    assert.ok(seen.length > 0, "workers reported progress")
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "the summed count never decreases")
    assert.ok(seen.at(-1) <= pairCount, `summed count stays within the total (${seen.at(-1)} of ${pairCount})`)
})

test("scoring without an onProgress callback still works", async () => {
    const base = build(60)
    const units = [{ members: base.subjects }]
    const out = await scorePairs({ ...base, units, pairCount: 60 * 59 / 2, workers: 1, progressMask: 0x3F })
    assert.ok(Array.isArray(out))
})
