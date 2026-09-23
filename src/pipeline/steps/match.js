import { sparqlSelect } from "@foerderfunke/sem-ops-utils"
import { COMMON_PREFIXES, writeTurtleFile } from "../write-turtle.js"
import { MAPPED_GRAPH } from "./map.js"
import { CDP, NAMESPACES, parseTtl, prefixes, shrink, turtlePrefixBlock } from "../../utils.js"
import { token_set_ratio, token_sort_ratio, ratio } from "fuzzball"
import { DataFactory } from "n3"
import { createHash } from "crypto"
import { Worker } from "worker_threads"
import os from "os"
import path from "path"
import fs from "fs"

const df = DataFactory

export const MATCH_GRAPH = df.namedNode("urn:matched")
export const HAS_MEMBER  = df.namedNode(CDP + "hasMember")

const RDF_TYPE      = df.namedNode(`${NAMESPACES.rdf}type`)
const MATCH_CLUSTER = df.namedNode(CDP + "MatchCluster")

// Fuzzy string similarity for weighted criteria, 0–100 normalised to 0–1. A rule picks
// one per :matchAlgorithm (default token_set_ratio): token_set scores over the token-set
// intersection — robust to legal-form noise and word order, good for centre names; ratio
// is plain edit distance, where a short name is not a perfect subset-match of a longer one,
// good for org names ("SKM Krefeld" vs "SKM Warendorf"). Recorded on each evidence node.
// https://github.com/nol13/fuzzball.js
const ALGORITHMS = { token_set_ratio, token_sort_ratio, ratio }
const DEFAULT_ALGORITHM = "token_set_ratio"

// Below this many pairs the work is not worth a worker's startup, so scoring
// stays in-process. Measured: fuzzball alone starts in milliseconds -- unlike a
// worker that would have to re-import a query engine -- but a few thousand pairs
// still finish before a thread is ready.
export const WORKER_PAIR_THRESHOLD = 200_000

// Score every unit's pairs, in workers when there is enough work to pay for
// them. Returns matches in unit order either way: a unit is scored by exactly
// one worker, so a stable sort by unit index reproduces the sequential order
// exactly, whichever worker finished first.
export const scorePairs = async ({ units, pairCount, hard, weighted, minScore, algoName,
                            hardVals, weightedVals, sourceOf, dedupsWithin, workers, score,
                            // Injectable so a test can force the worker path on a
                            // workload small enough to compare exhaustively.
                            threshold = WORKER_PAIR_THRESHOLD }) => {
    const sequential = () => {
        const out = []
        for (const [order, { members, against }] of units.entries()) {
            const pairs = against
                ? against.map(b => [members[0], b])
                : members.flatMap((a, i) => members.slice(i + 1).map(b => [a, b]))
            for (const [a, b] of pairs) {
                if (a === b) continue
                const sa = sourceOf.get(a)
                if (sa === sourceOf.get(b) && !dedupsWithin(sa)) continue
                const m = score(a, b)
                if (m) out.push({ order, a, b, ...m })
            }
        }
        return out
    }
    if (workers <= 1 || pairCount < threshold) return sequential()

    // Only the subjects a worker actually needs cross the boundary, remapped to
    // local indices: the copy of the value table is what caps the speedup, so it
    // is kept to the slice each worker scores.
    const weight = (u) => u.against ? u.against.length : u.members.length * (u.members.length - 1) / 2
    const slices = Array.from({ length: workers }, () => ({ units: [], work: 0 }))
    for (const [order, unit] of [...units.entries()].sort((x, y) => weight(y[1]) - weight(x[1]))) {
        const slice = slices.reduce((a, b) => (a.work <= b.work ? a : b))
        slice.units.push({ order, unit })
        slice.work += weight(unit)
    }

    const sourceIndex = new Map()
    const dedupFlags = []
    const sourceIdOf = (iri) => {
        const src = sourceOf.get(iri)
        if (!sourceIndex.has(src)) { sourceIndex.set(src, dedupFlags.length); dedupFlags.push(!!dedupsWithin(src)) }
        return sourceIndex.get(src)
    }

    const runSlice = ({ units: assigned }) => new Promise((resolve, reject) => {
        const local = new Map()
        const iris = []
        const idx = (iri) => {
            if (!local.has(iri)) { local.set(iri, iris.length); iris.push(iri) }
            return local.get(iri)
        }
        const payloadUnits = assigned.map(({ order, unit }) => ({
            order,
            members: unit.members.map(idx),
            against: unit.against?.map(idx),
        }))
        const worker = new Worker(path.join(import.meta.dirname, "match-worker.js"), {
            workerData: {
                units: payloadUnits,
                hardVals: iris.map(i => hardVals.get(i)),
                weightedVals: iris.map(i => weightedVals.get(i)),
                sourceOf: iris.map(sourceIdOf),
                dedupsWithin: dedupFlags,
                hard: hard.map(h => ({ optional: !!h.optional })),
                weighted: weighted.map(c => ({ weight: c.weight, minSim: c.minSim })),
                minScore, algo: algoName,
            },
        })
        worker.on("message", (found) => resolve(found.map(f => ({
            order: f.order, a: iris[f.a], b: iris[f.b], aggregate: f.aggregate,
            scores: f.scores.map(sc => ({
                pred: weighted[sc.i].pred, sim: sc.sim, weight: weighted[sc.i].weight,
                valueA: sc.valueA, valueB: sc.valueB,
            })),
        }))))
        worker.on("error", reject)
    })

    const found = (await Promise.all(slices.filter(s => s.units.length).map(runSlice))).flat()
    // Stable sort by unit index: a unit lives in one slice, so its pairs stay in
    // the order that slice produced them, which is the sequential order.
    return found.sort((x, y) => x.order - y.order)
}

export const runMatch = async ({ store, defStore, abs }, outPath, registryPath, historyPath) => {
    // The identity registry (minted IRI :hasMember source IRI, one assignment
    // per member) makes minting write-once: an entity's IRI is computed at
    // most once — at first sight — recorded here, and afterwards only looked
    // up, so membership can change without identity churn. Instance state to
    // commit, neither config nor regenerable data; empty on a fresh instance.
    const registry = new Map() // member source IRI → minted IRI
    if (fs.existsSync(abs(registryPath))) {
        for (const q of parseTtl(fs.readFileSync(abs(registryPath), "utf8"))) {
            if (q.predicate.value === HAS_MEMBER.value) registry.set(q.object.value, q.subject.value)
        }
    }
    const reserved = new Set(registry.values()) // every IRI ever minted — never mint one again
    const known    = new Set(registry.keys())   // members assigned in a prior run
    const taken = new Set()                     // minted IRIs claimed by a cluster this run
    let reusedCount = 0, mintedCount = 0

    // :harvestingModeActive gates persisting the registry/history — matching
    // and every other pipeline step still run in full either way, so a
    // non-harvesting run's merged/final output is unaffected; only the
    // write-once identity commit is skipped. Absent → true (existing behaviour).
    const [harvestingRow] = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?harvestingModeActive WHERE { :federation :harvestingModeActive ?harvestingModeActive }`, [defStore])
    const harvesting = harvestingRow?.harvestingModeActive !== "false"

    // Scoring runs in worker threads when a rule has enough pairs to pay for
    // them. Capped below the core count by default: the main thread still has
    // to apply every result, and it is the one holding the whole store.
    const [workerRow] = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?n WHERE { :federation :maxMatchWorkers ?n }`, [defStore])
    const workers = Math.max(1, Number(workerRow?.n) || Math.min(4, Math.max(1, os.cpus().length - 1)))
    // Identity events this run, appended to history.ttl (the registry's
    // provenance): when each entity was first minted, gained a member, or
    // absorbed/split off another. Append-only and written only when non-empty,
    // so a no-change harvest leaves the file — and its git diff — untouched.
    const events = []

    // One match rule per target schema; each rule scores its own fields, mints
    // with its own prefix, and clusters only subjects of its :targetClass.
    const rules = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?match ?target ?targetClass ?ns ?prefix ?minScore ?algo WHERE {
            ?match a :MatchRule ;
                :forTarget           ?target ;
                :targetNamespace     ?ns ;
                :mintedSubjectPrefix ?prefix .
            ?target :targetClass ?targetClass .
            OPTIONAL { ?match :minScore ?minScore }
            OPTIONAL { ?match :matchAlgorithm ?algo }
        } ORDER BY ?match`, [defStore])
    if (!rules.length) throw new Error(":MatchRule config missing in federation.ttl")

    const criteriaRows = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?match ?on ?weight ?minSim WHERE {
            ?match a :MatchRule ; :hasWeightedCriterion ?c .
            ?c :on ?on ; :weight ?weight .
            OPTIONAL { ?c :minSimilarity ?minSim }
        }`, [defStore])
    // Hard criteria: fields that must be identical in both records (pass/fail
    // gates). :optional true relaxes a gate to "reject when both present and
    // different" — without it a record missing the field matches nothing.
    const hardRows = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?match ?on ?optional WHERE {
            ?match a :MatchRule ; :hasHardCriterion ?h . ?h :on ?on .
            OPTIONAL { ?h :optional ?optional }
        }`, [defStore])
    // Blocking keys: fields that partition the comparison space without deciding
    // anything. A hard criterion is trivially a valid partition -- if differing
    // values mean rejection, differing records need not be compared -- but the
    // reverse does not hold, which is why this is a separate declaration. A
    // normalised name token partitions well, yet gating on it would reject
    // "Programme X" against "EU Programme X", the very pairs the weighted
    // scoring exists to catch.
    const blockingRows = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?match ?on WHERE {
            ?match a :MatchRule ; :hasBlockingKey ?b . ?b :on ?on .
        }`, [defStore])
    const blockingByMatch = new Map()
    for (const r of blockingRows) {
        if (!blockingByMatch.has(r.match)) blockingByMatch.set(r.match, [])
        blockingByMatch.get(r.match).push({ pred: df.namedNode(r.on) })
    }
    // Criteria keyed by their owning rule, so each pass scores on its own fields.
    const criteriaByMatch = new Map()
    for (const r of criteriaRows) {
        if (!criteriaByMatch.has(r.match)) criteriaByMatch.set(r.match, [])
        criteriaByMatch.get(r.match).push({
            pred:   df.namedNode(r.on),
            weight: parseFloat(r.weight),
            minSim: r.minSim != null ? parseFloat(r.minSim) : null,
        })
    }
    const hardByMatch = new Map()
    for (const r of hardRows) {
        if (!hardByMatch.has(r.match)) hardByMatch.set(r.match, [])
        hardByMatch.get(r.match).push({ pred: df.namedNode(r.on), optional: r.optional === "true" })
    }

    // A criterion :on a relationship predicate (an entity link, e.g. schema:address
    // or schema:provider) compares *minted* identities, so the rule owning the
    // linked schema must run first. The dependencies follow from declarations that
    // already exist — each mapping's :hasRelationship names the predicate and the
    // schema it points at — and the rules are topologically sorted by them
    // (declaration order breaks ties; a cycle warns and keeps declaration order).
    const relPredRows = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT DISTINCT ?pred ?toSchema WHERE {
            [] :hasRelationship ?rel .
            ?rel :toTargetField/:targetPredicate ?pred ; :toTargetSchema ?toSchema .
        }`, [defStore])
    const schemasOfPred = new Map()
    for (const r of relPredRows) {
        if (!schemasOfPred.has(r.pred)) schemasOfPred.set(r.pred, new Set())
        schemasOfPred.get(r.pred).add(r.toSchema)
    }
    const ruleOfSchema = new Map(rules.map(r => [r.target, r]))
    const depsOf = (rule) => {
        const preds = [...(hardByMatch.get(rule.match) ?? []), ...(criteriaByMatch.get(rule.match) ?? [])]
        return [...new Set(preds.flatMap(c => [...(schemasOfPred.get(c.pred.value) ?? [])]))]
            .map(s => ruleOfSchema.get(s)).filter(r => r && r !== rule)
    }
    const orderedRules = []
    const visitState = new Map()
    const visit = (rule, stack = []) => {
        if (visitState.get(rule.match) === "done") return
        if (visitState.get(rule.match) === "visiting") {
            console.warn(`match: rule dependency cycle (${[...stack, rule.match].map(m => m.split("#").pop()).join(" → ")}) — keeping declaration order`)
            return
        }
        visitState.set(rule.match, "visiting")
        for (const d of depsOf(rule)) visit(d, [...stack, rule.match])
        visitState.set(rule.match, "done")
        orderedRules.push(rule)
    }
    for (const r of rules) visit(r)
    // Source IRI → minted IRI, filled as each pass mints; later passes' valOf
    // resolves entity-link criterion values through it.
    const mintedThisRun = new Map()
    // owl:sameAs assertions are shared; each pass only acts on the pairs whose
    // endpoints are in its own subject set (gated by parent.has below).
    const sameAsRows = await sparqlSelect(`
        PREFIX owl: <${NAMESPACES.owl}>
        SELECT ?a ?b WHERE { ?a owl:sameAs ?b }`, [defStore])

    // owl:differentFrom pins two records apart — a curated veto on a merge. The
    // pairwise scan below never unions a distinct pair, even when its score clears
    // the rule (e.g. two co-located einrichtungen whose names overlap).
    const differentRows = await sparqlSelect(`
        PREFIX owl: <${NAMESPACES.owl}>
        SELECT ?a ?b WHERE { ?a owl:differentFrom ?b }`, [defStore])
    const distinctPairs = new Set()
    for (const { a, b } of differentRows) { distinctPairs.add(`${a}|${b}`); distinctPairs.add(`${b}|${a}`) }

    // Each record's source (cdp:fromSource), and whether a source dedups within
    // itself. A source whose own IDs already distinguish its entities sets
    // :dedupWithinSource false, so the pairwise scan skips same-source pairs —
    // only cross-source pairs fuzzy-match. Default true. Explicit owl:sameAs
    // still merges same-source pairs (it runs earlier, ungated by this).
    const FROM_SOURCE = df.namedNode(CDP + "fromSource")
    const sourceOf = new Map()
    for (const q of store.getQuads(null, FROM_SOURCE, null, MAPPED_GRAPH)) sourceOf.set(q.subject.value, q.object.value)
    const dedupRows = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?source ?dedup WHERE { ?source a :Source . OPTIONAL { ?source :dedupWithinSource ?dedup } }`, [defStore])
    const dedupWithinSource = new Map(dedupRows.map(r => [r.source, r.dedup !== "false"]))
    const dedupsWithin = (src) => dedupWithinSource.get(src) ?? true

    const MATCH_EVIDENCE     = df.namedNode(CDP + "MatchEvidence")
    const HAS_MATCH_EVIDENCE = df.namedNode(CDP + "hasMatchEvidence")
    const PAIR               = df.namedNode(CDP + "pair")
    const ON_CRITERION       = df.namedNode(CDP + "onCriterion")
    const ON                 = df.namedNode(CDP + "on")
    const SIMILARITY         = df.namedNode(CDP + "similarity")
    const SIM_ALGORITHM      = df.namedNode(CDP + "similarityAlgorithm")
    const WEIGHT             = df.namedNode(CDP + "weight")
    const VALUE_A            = df.namedNode(CDP + "valueA")
    const VALUE_B            = df.namedNode(CDP + "valueB")
    const AGGREGATE_SCORE    = df.namedNode(CDP + "aggregateScore")
    const VIA_MANUAL_MATCH   = df.namedNode(CDP + "viaManualMatch")
    const XSD_DECIMAL        = df.namedNode(`${NAMESPACES.xsd}decimal`)
    const XSD_BOOLEAN        = df.namedNode(`${NAMESPACES.xsd}boolean`)

    for (const rule of orderedRules) {
        const namespace    = rule.ns
        const mintedPrefix = rule.prefix
        const minScore     = parseFloat(rule.minScore)
        const hard     = hardByMatch.get(rule.match) ?? []
        const blocking = blockingByMatch.get(rule.match) ?? []
        const weighted = criteriaByMatch.get(rule.match) ?? []
        const algoName = rule.algo ?? DEFAULT_ALGORITHM
        if (!ALGORITHMS[algoName]) throw new Error(`match: unknown :matchAlgorithm "${algoName}" — use ${Object.keys(ALGORITHMS).join(", ")}`)
        const similarity = (a, b) => ALGORITHMS[algoName](a ?? "", b ?? "") / 100

        // Subjects of this rule's target class only — passes never cross types.
        const subjects = [...new Set(store.getQuads(null, RDF_TYPE, df.namedNode(rule.targetClass), MAPPED_GRAPH)
            .filter(qu => qu.subject.termType === "NamedNode")
            .map(qu => qu.subject.value))]

        // Only a predicate's first quad: a criterion on a multi-valued field
        // compares one arbitrary member, so two records listing the same values
        // in a different order fail the gate. Hard criteria must be single-valued.
        const valOf = (s, pred) => {
            const qs = store.getQuads(df.namedNode(s), pred, null, MAPPED_GRAPH)
            if (!qs.length) return null
            const o = qs[0].object
            // Entity links compare by minted identity — the topological order
            // guarantees the linked schema's pass already ran for criterion predicates.
            return o.termType === "NamedNode" ? (mintedThisRun.get(o.value) ?? o.value) : o.value
        }
        const hardVals     = new Map(subjects.map(s => [s, hard.map(h => valOf(s, h.pred))]))
        const weightedVals = new Map(subjects.map(s => [s, weighted.map(c => valOf(s, c.pred))]))

        // A pair matches when every hard criterion is present and identical in both,
        // and the weighted criteria's aggregate (sum of sim·weight, each optionally
        // floored by :minSimilarity) clears :minScore. No criteria at all → every
        // subject stays its own cluster.
        const matches = (a, b) => {
            if (!hard.length && !weighted.length) return null
            const ha = hardVals.get(a), hb = hardVals.get(b)

            for (let i = 0; i < hard.length; i++) {
                // Absent on either side: an optional gate doesn't apply (the
                // records may still match on the weighted criteria), a required
                // one rejects.
                if (ha[i] == null || hb[i] == null) {
                    if (hard[i].optional) continue
                    return null
                }
                if (ha[i] !== hb[i]) return null
            }
            const va = weightedVals.get(a), vb = weightedVals.get(b)
            const scores = []
            let weightedSum = 0
            for (let i = 0; i < weighted.length; i++) {
                if (va[i] == null || vb[i] == null) return null
                const c = weighted[i]
                const sim = similarity(va[i], vb[i])
                if (c.minSim != null && sim < c.minSim) return null
                scores.push({ pred: c.pred, sim, weight: c.weight, valueA: va[i], valueB: vb[i] })
                weightedSum += sim * c.weight
            }
            if (weighted.length && weightedSum < minScore) return null
            return { scores, aggregate: weightedSum }
        }

        const parent = new Map(subjects.map(s => [s, s]))
        const find = (x) => {
            let r = x
            while (parent.get(r) !== r) r = parent.get(r)
            let c = x
            while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n }
            return r
        }
        const union = (a, b) => {
            const ra = find(a), rb = find(b)
            if (ra !== rb) parent.set(ra, rb)
        }

        const evidence = []
        let sameAsUnions = 0
        let keptDistinct = 0
        for (const { a, b } of sameAsRows) {
            if (parent.has(a) && parent.has(b)) { union(a, b); sameAsUnions++; evidence.push({ a, b, manual: true }) }
        }

        // Grouping turns the O(n²) all-pairs scan into a per-bucket
        // O(Σ mᵢ²) one. The hard checks are redundant after bucketing,
        // but introduces a cheap correctness check
        // buckets: a subject's bucket key is the JSON of its **required** hard
        // value tuple, so subjects sharing identical required hard values land
        // in the same bucket. Optional criteria stay out of the key — a record
        // missing one still has to be compared — and matches() gates on them
        // within the bucket. All-optional (or no) hard criteria means one
        // bucket, i.e. the plain all-pairs scan.
        const requiredIdx = hard.map((h, i) => h.optional ? -1 : i).filter(i => i >= 0)
        // Every value of a blocking predicate, not just the first: a record
        // belongs in one bucket per value, and a pair meeting in any bucket is
        // compared. More keys therefore means more recall, never less — the
        // opposite of a multi-valued hard criterion, which valOf silently
        // reduces to one arbitrary member.
        const valuesOf = (s, pred) => store.getQuads(df.namedNode(s), pred, null, MAPPED_GRAPH)
            .map(qu => qu.object.termType === "NamedNode" ? (mintedThisRun.get(qu.object.value) ?? qu.object.value) : qu.object.value)
        // Prefixed by which declaration produced them, so two blocking keys
        // sharing a value don't collide into one bucket.
        const blockVals = new Map(subjects.map(s =>
            [s, blocking.flatMap((b, i) => valuesOf(s, b.pred).map(v => `${i}\u0000${v}`))]))

        const buckets = new Map()
        const intoBucket = (key, s) => {
            if (!buckets.has(key)) buckets.set(key, [])
            buckets.get(key).push(s)
        }
        // A record carrying no blocking value rules nothing out, so it has to be
        // compared against everything. That is the cost of not knowing, and it
        // is why a blocking key must never make a record unmatchable the way a
        // missing hard value does — blocking narrows the question, it never
        // answers it.
        const unblocked = []
        // A required hard value the record simply doesn't carry makes it
        // unmatchable — correct, but silent until now: the run looks healthy
        // while the record sits out of the federation entirely.
        let unmatchable = 0
        for (const s of subjects) {
            const hv = hardVals.get(s)
            if (requiredIdx.length && requiredIdx.some(i => hv[i] == null)) { unmatchable++; continue }
            const hardKey = requiredIdx.map(i => hv[i])
            if (!blocking.length) { intoBucket(JSON.stringify(hardKey), s); continue }
            const bv = blockVals.get(s)
            if (!bv.length) { unblocked.push(s); continue }
            for (const v of bv) intoBucket(JSON.stringify([...hardKey, v]), s)
        }
        if (unmatchable) console.warn(`match: ${rule.match.split("#").pop()} ${unmatchable} of ${subjects.length} entities carry no value for a required hard criterion and can match nothing — declare :optional true on the criterion to let them fall through`)

        // Blocking puts a record in several buckets, so the same pair can come
        // up more than once. Comparing it twice would duplicate its evidence in
        // the match log, so each unordered pair is considered once.
        const considered = new Set()
        const considerPair = (a, b, m) => {
            if (a === b) return
            const key = a < b ? `${a}|${b}` : `${b}|${a}`
            if (considered.has(key)) return
            considered.add(key)
            const sa = sourceOf.get(a)
            if (sa === sourceOf.get(b) && !dedupsWithin(sa)) return  // source trusts its own IDs
            if (!m) return
            if (distinctPairs.has(`${a}|${b}`)) { keptDistinct++; return }  // owl:differentFrom veto
            union(a, b); evidence.push({ a, b, ...m })
        }

        // Work units in a fixed order: each bucket, then each unblocked record
        // against every subject. The order is what makes the parallel path
        // reproducible -- results are applied in it regardless of which worker
        // finishes first, so clustering cannot depend on scheduling.
        const units = [...buckets.values()].map(members => ({ members }))
        for (const a of unblocked) units.push({ members: [a], against: subjects })
        const pairCount = units.reduce((n, u) =>
            n + (u.against ? u.against.length : u.members.length * (u.members.length - 1) / 2), 0)

        const scored = await scorePairs({
            units, pairCount, subjects, hard, weighted, minScore, algoName,
            hardVals, weightedVals, sourceOf, dedupsWithin, workers,
            score: matches,
        })
        for (const { a, b, ...m } of scored) considerPair(a, b, m)

        const clusters = new Map()
        for (const s of subjects) {
            const root = find(s)
            if (!clusters.has(root)) clusters.set(root, [])
            clusters.get(root).push(s)
        }
        const clusterMembers = [...clusters.values()]
            .map(m => [...m].sort())
            .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))

        let multiMember = 0
        const clusterIriByRoot = new Map()
        for (const members of clusterMembers) {
            // Reconcile against the registry: any member already known → its
            // entity exists, reuse the IRI (clusters come largest-first, so on
            // a split the larger fragment keeps the identity). Only unseen
            // entities mint, seeded by their smallest member at mint time — a
            // one-time uniqueness seed, not a content address: the registry
            // pins the IRI afterwards, however membership evolves.
            const prior = [...new Set(members.map(m => registry.get(m)).filter(Boolean))].sort()
            const free = prior.filter(iri => !taken.has(iri))
            let minted
            // TODO: merge and split (prior carrying ≥2 IRIs in the reuse branch,
            // or any prior in the mint branch) are reconciled correctly — a
            // survivor keeps the IRI — but their history events (:Merged /
            // :Split) and the tombstone they imply (the retired IRI preserved
            // with :isReplacedBy, rather than silently vanishing from
            // identity.ttl) are their own rung. For now they only warn.
            if (free.length) {
                minted = df.namedNode(free[0])
                reusedCount++
                const joined = members.filter(m => !known.has(m))
                if (joined.length) events.push({ type: "MemberJoined", entity: free[0], member: joined })
                if (prior.length > 1) console.warn(`match: clusters merged (${prior.join(" + ")}) — keeping ${free[0]}`)
            } else {
                if (prior.length) console.warn(`match: cluster split off ${prior.join(", ")} — minting fresh`)
                let id = createHash("sha1").update(members[0]).digest("hex").slice(0, 12)
                // Seed collision (e.g. a split remainder re-hashing its old anchor): re-hash until free.
                while (taken.has(namespace + mintedPrefix + id) || reserved.has(namespace + mintedPrefix + id))
                    id = createHash("sha1").update(id).digest("hex").slice(0, 12)
                minted = df.namedNode(namespace + mintedPrefix + id)
                mintedCount++
                if (!prior.length) events.push({ type: "Minted", entity: minted.value, member: members })
            }
            taken.add(minted.value)
            for (const m of members) { registry.set(m, minted.value); mintedThisRun.set(m, minted.value) }
            clusterIriByRoot.set(find(members[0]), minted)
            if (members.length > 1) multiMember++
            store.addQuad(df.quad(minted, RDF_TYPE, MATCH_CLUSTER, MATCH_GRAPH))
            for (const s of members) {
                store.addQuad(df.quad(minted, HAS_MEMBER, df.namedNode(s), MATCH_GRAPH))
            }
        }

        for (const ev of evidence) {
            const evNode = df.blankNode()
            const cluster = clusterIriByRoot.get(find(ev.a))
            store.addQuad(df.quad(cluster, HAS_MATCH_EVIDENCE, evNode, MATCH_GRAPH))
            store.addQuad(df.quad(evNode, RDF_TYPE, MATCH_EVIDENCE, MATCH_GRAPH))
            store.addQuad(df.quad(evNode, PAIR, df.namedNode(ev.a), MATCH_GRAPH))
            store.addQuad(df.quad(evNode, PAIR, df.namedNode(ev.b), MATCH_GRAPH))
            if (ev.manual) {
                store.addQuad(df.quad(evNode, VIA_MANUAL_MATCH, df.literal("true", XSD_BOOLEAN), MATCH_GRAPH))
            } else {
                store.addQuad(df.quad(evNode, AGGREGATE_SCORE, df.literal(ev.aggregate.toFixed(3), XSD_DECIMAL), MATCH_GRAPH))
                store.addQuad(df.quad(evNode, SIM_ALGORITHM, df.literal(algoName), MATCH_GRAPH))
                for (const s of ev.scores) {
                    const cNode = df.blankNode()
                    store.addQuad(df.quad(evNode, ON_CRITERION, cNode, MATCH_GRAPH))
                    store.addQuad(df.quad(cNode, ON, s.pred, MATCH_GRAPH))
                    store.addQuad(df.quad(cNode, SIMILARITY, df.literal(s.sim.toFixed(3), XSD_DECIMAL), MATCH_GRAPH))
                    store.addQuad(df.quad(cNode, WEIGHT, df.literal(s.weight.toFixed(2), XSD_DECIMAL), MATCH_GRAPH))
                    store.addQuad(df.quad(cNode, VALUE_A, df.literal(s.valueA), MATCH_GRAPH))
                    store.addQuad(df.quad(cNode, VALUE_B, df.literal(s.valueB), MATCH_GRAPH))
                }
            }
        }

        console.log(`match: ${rule.match.split("#").pop()} ${subjects.length} entities in ${buckets.size} bucket(s) → ${clusters.size} clusters (${multiMember} multi-member, ${sameAsUnions} sameAs unions, ${keptDistinct} kept distinct)`)
        // A blocking key that is too aggressive loses true matches silently —
        // the pairs are never compared, so no score exists to notice missing.
        // The shape of the buckets is the only warning an author gets, so it is
        // reported rather than left to be inferred from a bucket count: the
        // largest bucket is where the time actually goes, and the unblocked
        // count is how many records the key failed to place at all.
        if (blocking.length) {
            const sizes = [...buckets.values()].map(b => b.length).sort((x, y) => x - y)
            const median = sizes.length ? sizes[sizes.length >> 1] : 0
            console.log(`match: ${rule.match.split("#").pop()} blocking — largest bucket ${sizes.at(-1) ?? 0}, median ${median}, ${considered.size} pairs compared, ${unblocked.length} entities unblocked (compared against all)`)
        }
    }

    // cdp:matchString was extract's private matching surface (a normalised name the
    // criteria compared on). Now that matching is done it has served its purpose, so
    // drop it from the mapped graph — it would otherwise ride into merged.ttl and the
    // Merge view, where it means nothing to a reviewer.
    store.removeMatches(null, df.namedNode(CDP + "matchString"), null, MAPPED_GRAPH)

    const matchQuads = store.getQuads(null, null, null, MATCH_GRAPH)
    await writeTurtleFile(abs(outPath), matchQuads, { cdp: CDP, cdf: rules[0].ns, ...COMMON_PREFIXES })
    console.log(`match: wrote cluster log → ${outPath}`)

    if (harvesting) {
        await writeTurtleFile(abs(registryPath), [...registry].map(([member, minted]) =>
            df.quad(df.namedNode(minted), HAS_MEMBER, df.namedNode(member))), { cdp: CDP, cdf: rules[0].ns })
        console.log(`match: identity registry ${reusedCount} reused, ${mintedCount} minted → ${registryPath}`)
    } else {
        console.log(`match: identity registry ${reusedCount} reused, ${mintedCount} minted (harvesting mode off — not written)`)
    }

    // Append this run's events to the history (the registry's provenance) as
    // one :Revision node carrying the timestamp, with each event hung off it as
    // a nested [entity ; members] binding under a type predicate (cdp:minted /
    // cdp:memberJoined). Revisions count only changing runs — a no-op harvest
    // appends nothing — so the next number is one past the highest on file. The
    // whole block is one append, so the named :Revision and its fresh blank
    // nodes never collide with earlier revisions when the file is re-parsed.
    if (harvesting && events.length) {
        const prefixMap = { cdp: CDP, cdf: rules[0].ns }
        const sh   = (iri) => shrink(iri, prefixMap)
        const list = (arr) => arr.map(sh).join(", ")
        const existing = fs.existsSync(abs(historyPath)) ? fs.readFileSync(abs(historyPath), "utf8") : ""
        const rev = Math.max(0, ...[...existing.matchAll(/revision-(\d+)/g)].map(m => +m[1])) + 1

        const byPredicate = new Map() // cdp:minted / cdp:memberJoined → binding strings
        for (const e of events) {
            const pred = "cdp:" + e.type[0].toLowerCase() + e.type.slice(1)
            if (!byPredicate.has(pred)) byPredicate.set(pred, [])
            byPredicate.get(pred).push(`[ cdp:entity ${sh(e.entity)} ; cdp:member ${list(e.member)} ]`)
        }
        const props = [...byPredicate].map(([pred, bindings]) =>
            `    ${pred}\n        ${bindings.join(" ,\n        ")}`).join(" ;\n")
        const block = `cdp:revision-${rev} a cdp:Revision ; prov:atTime "${new Date().toISOString()}"^^xsd:dateTime ;\n${props} .\n`

        const header = `${turtlePrefixBlock({ cdp: CDP, cdf: rules[0].ns, ...prefixes("prov", "xsd") })}\n\n`
        fs.appendFileSync(abs(historyPath), (existing ? "\n" : header) + block)
        console.log(`match: revision ${rev} — ${events.length} identity event(s) → ${historyPath}`)
    }
}
