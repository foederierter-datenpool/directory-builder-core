// Similarity scoring for one slice of a match rule's buckets.
//
// Runs in a worker thread because scoring is the only part of matching that is
// pure: it reads values and returns scores, touching none of the union-find,
// the evidence log or the cross-bucket pair set. Those stay on the main thread,
// which applies results in a fixed order so clustering cannot become
// run-dependent.
//
// Nothing here imports a query engine. That is why this pays where a worker
// around extract does not: fuzzball alone starts in milliseconds, where
// re-importing Comunica per worker costs more than the work it would save.
import { parentPort, workerData } from "worker_threads"
import { token_set_ratio, token_sort_ratio, ratio } from "fuzzball"

const ALGORITHMS = { token_set_ratio, token_sort_ratio, ratio }

const { hardVals, weightedVals, sourceOf, dedupsWithin, hard, weighted, minScore, algo, units, progressMask } = workerData
const similarity = (a, b) => ALGORITHMS[algo](a ?? "", b ?? "") / 100

// Mirrors the main thread's matches(); values arrive as parallel arrays indexed
// by a local subject index, so no IRIs cross the thread boundary.
const score = (a, b) => {
    if (!hard.length && !weighted.length) return null
    const ha = hardVals[a], hb = hardVals[b]
    for (let i = 0; i < hard.length; i++) {
        if (ha[i] == null || hb[i] == null) {
            if (hard[i].optional) continue
            return null
        }
        if (ha[i] !== hb[i]) return null
    }
    const va = weightedVals[a], vb = weightedVals[b]
    const scores = []
    let weightedSum = 0
    for (let i = 0; i < weighted.length; i++) {
        if (va[i] == null || vb[i] == null) return null
        const c = weighted[i]
        const sim = similarity(va[i], vb[i])
        if (c.minSim != null && sim < c.minSim) return null
        scores.push({ i, sim, valueA: va[i], valueB: vb[i] })
        weightedSum += sim * c.weight
    }
    if (weighted.length && weightedSum < minScore) return null
    return { scores, aggregate: weightedSum }
}

// Comparisons done, reported to the parent so a long match can be told from a
// stuck one. The test is a bitmask rather than a modulo because it runs once per
// pair -- the one loop where per-iteration cost is the runtime -- and it fires
// about once per million pairs, so the postMessage is not on the hot path either.
let compared = 0
const tick = () => { if ((++compared & progressMask) === 0) parentPort.postMessage({ progress: compared }) }

// A unit is one bucket (or one unblocked record against every subject), carried
// with the order it had on the main thread so results can be replayed in it.
const out = []
for (const { order, members, against } of units) {
    if (against) {
        for (const b of against) {
            if (members[0] === b) continue
            tick()
            if (sourceOf[members[0]] === sourceOf[b] && !dedupsWithin[sourceOf[members[0]]]) continue
            const m = score(members[0], b)
            if (m) out.push({ order, a: members[0], b, ...m })
        }
        continue
    }
    for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
            const a = members[i], b = members[j]
            tick()
            if (sourceOf[a] === sourceOf[b] && !dedupsWithin[sourceOf[a]]) continue
            const m = score(a, b)
            if (m) out.push({ order, a, b, ...m })
        }
    }
}
parentPort.postMessage({ found: out, compared })
