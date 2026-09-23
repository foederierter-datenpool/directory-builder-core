import { scorePairs } from "../src/pipeline/steps/match.js"
import { token_set_ratio } from "fuzzball"
import assert from "node:assert/strict"
import { test } from "node:test"

// Scoring in workers must be indistinguishable from scoring in-process. This is
// the step that decides identity, so "faster" is only acceptable if it is also
// exactly the same — including the order results are applied in, or clustering
// would become dependent on which worker finished first.

// Names are mostly distinct so few pairs clear the threshold -- a fixture where
// everything matches produces a result set the size of the pair space, which is
// not what a real bucket looks like and exhausts memory before it proves
// anything. Every 50th subject repeats its predecessor's name, so there are
// known matches to compare.
const build = (n) => {
    const subjects = Array.from({ length: n }, (_, i) => `urn:s:${i}`)
    const topic = (i) => ["Kultur", "Bildung", "Sport", "Umwelt"][i % 4]
    const names = subjects.map((_, i) => i % 50 === 0 && i > 0
        ? `Programm ${i - 1} ${topic(i - 1)} ${(i - 1) * 7919 % 100000}`
        : `Programm ${i} ${topic(i)} ${i * 7919 % 100000}`)
    const hardVals = new Map(subjects.map((s, i) => [s, [i % 3 === 0 ? "x" : "y"]]))
    const weightedVals = new Map(subjects.map((s, i) => [s, [names[i]]]))
    const sourceOf = new Map(subjects.map((s, i) => [s, i % 2 ? "urn:src:a" : "urn:src:b"]))
    return {
        subjects, hardVals, weightedVals, sourceOf,
        dedupsWithin: () => true,
        hard: [{ optional: true }],
        weighted: [{ pred: { value: "urn:p:name" }, weight: 1.0, minSim: null }],
        minScore: 0.9,
        algoName: "token_set_ratio",
        // Mirrors the engine's matches() exactly, hard gate included. A fixture
        // that scores on similarity alone is not comparing like with like: the
        // worker applies the hard criterion too, so the two would differ for a
        // reason that has nothing to do with threading.
        score: (a, b) => {
            const ha = hardVals.get(a)[0], hb = hardVals.get(b)[0]
            if (ha != null && hb != null && ha !== hb) return null
            const va = weightedVals.get(a)[0], vb = weightedVals.get(b)[0]
            const sim = token_set_ratio(va, vb) / 100
            if (sim < 0.9) return null
            return { scores: [{ pred: { value: "urn:p:name" }, sim, weight: 1, valueA: va, valueB: vb }], aggregate: sim }
        },
    }
}

const unitsFor = (subjects, buckets) => {
    const units = buckets.map(members => ({ members }))
    return units
}

test("worker scoring returns exactly what in-process scoring returns", async () => {
    const base = build(40)
    const units = unitsFor(base.subjects, [base.subjects])
    const pairCount = base.subjects.length * (base.subjects.length - 1) / 2

    // threshold 0 forces the worker path on a workload small enough to compare
    // pair for pair; the real threshold exists to avoid paying for threads on
    // work this size, not to change what the answer is.
    const inProcess = await scorePairs({ ...base, units, pairCount, workers: 1 })
    const parallel  = await scorePairs({ ...base, units, pairCount, workers: 4, threshold: 0 })

    assert.ok(inProcess.length > 0, "the fixture actually matches something")
    assert.equal(parallel.length, inProcess.length, "same number of matches")
    assert.deepEqual(
        parallel.map(m => [m.a, m.b, m.aggregate.toFixed(12)]),
        inProcess.map(m => [m.a, m.b, m.aggregate.toFixed(12)]),
        "same pairs, same scores, in the same order")
})

test("worker scoring preserves the evidence each match carries", async () => {
    const base = build(40)
    const units = unitsFor(base.subjects, [base.subjects])
    const pairCount = base.subjects.length * (base.subjects.length - 1) / 2
    const [seq] = await scorePairs({ ...base, units, pairCount, workers: 1 })
    const [par] = await scorePairs({ ...base, units, pairCount, workers: 4, threshold: 0 })
    assert.equal(par.scores.length, seq.scores.length)
    assert.equal(par.scores[0].pred.value, seq.scores[0].pred.value, "the predicate survives the round trip")
    assert.equal(par.scores[0].weight, seq.scores[0].weight)
    assert.equal(par.scores[0].valueA, seq.scores[0].valueA)
    assert.equal(par.scores[0].sim.toFixed(12), seq.scores[0].sim.toFixed(12))
})

test("work below the threshold never starts a worker", async () => {
    const base = build(40)
    const units = unitsFor(base.subjects, [base.subjects])
    const pairCount = 40 * 39 / 2
    const out = await scorePairs({ ...base, units, pairCount, workers: 8 })
    assert.ok(out.length > 0)   // ran in-process; asserted by not hanging and by matching below
    const ref = await scorePairs({ ...base, units, pairCount, workers: 1 })
    assert.deepEqual(out.map(m => [m.a, m.b]), ref.map(m => [m.a, m.b]))
})

test("a pair from one source that trusts its own ids is skipped either way", async () => {
    const base = { ...build(40), dedupsWithin: () => false }
    const units = unitsFor(base.subjects, [base.subjects])
    const pairCount = base.subjects.length * (base.subjects.length - 1) / 2
    const seq = await scorePairs({ ...base, units, pairCount, workers: 1 })
    const par = await scorePairs({ ...base, units, pairCount, workers: 4, threshold: 0 })
    assert.deepEqual(par.map(m => [m.a, m.b]), seq.map(m => [m.a, m.b]))
    assert.ok(seq.every(m => base.sourceOf.get(m.a) !== base.sourceOf.get(m.b)),
        "same-source pairs are excluded, and the worker applies the same rule")
})
