import { sparqlSelect } from "@foerderfunke/sem-ops-utils"
import { COMMON_PREFIXES, writeTurtleFile } from "../write-turtle.js"
import { MAPPED_GRAPH } from "./map.js"
import { CDP, parseTtl, shrink } from "../../utils.js"
import { token_set_ratio } from "fuzzball"
import { DataFactory } from "n3"
import { createHash } from "crypto"
import fs from "fs"

const df = DataFactory

export const MATCH_GRAPH = df.namedNode("urn:matched")
export const HAS_MEMBER  = df.namedNode(CDP + "hasMember")

const RDF_TYPE      = df.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
const MATCH_CLUSTER = df.namedNode(CDP + "MatchCluster")

// token_set_ratio computes a ratio over the intersection of token sets, which
// is robust to legal-form noise ("gGmbH", "e.V."), sub-unit specifiers, and
// word-order variations. Returns 0–100; we normalise to 0–1. The algorithm
// name is recorded in the evidence graph so old similarity numbers stay
// interpretable across algorithm swaps.
// https://github.com/nol13/fuzzball.js/blob/master/jsdocs/fuzzball.md#fuzzballtoken_set_ratiostr1-str2-options_p--number
const SIMILARITY_ALGORITHM = "token_set_ratio"
const similarity = (a, b) => token_set_ratio(a ?? "", b ?? "") / 100

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
    // Identity events this run, appended to history.ttl (the registry's
    // provenance): when each entity was first minted, gained a member, or
    // absorbed/split off another. Append-only and written only when non-empty,
    // so a no-change harvest leaves the file — and its git diff — untouched.
    const events = []

    // One match rule per target schema; each rule scores its own fields, mints
    // with its own prefix, and clusters only subjects of its :targetClass.
    const rules = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?match ?targetClass ?ns ?prefix ?minScore WHERE {
            ?match a :MatchRule ;
                :forTarget           ?target ;
                :targetNamespace     ?ns ;
                :mintedSubjectPrefix ?prefix .
            ?target :targetClass ?targetClass .
            OPTIONAL { ?match :minScore ?minScore }
        } ORDER BY ?match`, [defStore])
    if (!rules.length) throw new Error(":MatchRule config missing in federation.ttl")

    const criteriaRows = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?match ?on ?weight ?minSim WHERE {
            ?match a :MatchRule ; :hasWeightedCriterion ?c .
            ?c :on ?on ; :weight ?weight .
            OPTIONAL { ?c :minSimilarity ?minSim }
        }`, [defStore])
    // Hard criteria: fields that must be identical in both records (pass/fail gates).
    const hardRows = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?match ?on WHERE {
            ?match a :MatchRule ; :hasHardCriterion ?h . ?h :on ?on .
        }`, [defStore])
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
        hardByMatch.get(r.match).push({ pred: df.namedNode(r.on) })
    }
    // owl:sameAs assertions are shared; each pass only acts on the pairs whose
    // endpoints are in its own subject set (gated by parent.has below).
    const sameAsRows = await sparqlSelect(`
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        SELECT ?a ?b WHERE { ?a owl:sameAs ?b }`, [defStore])

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
    const XSD_DECIMAL        = df.namedNode("http://www.w3.org/2001/XMLSchema#decimal")
    const XSD_BOOLEAN        = df.namedNode("http://www.w3.org/2001/XMLSchema#boolean")

    for (const rule of rules) {
        const namespace    = rule.ns
        const mintedPrefix = rule.prefix
        const minScore     = parseFloat(rule.minScore)
        const hard     = hardByMatch.get(rule.match) ?? []
        const weighted = criteriaByMatch.get(rule.match) ?? []

        // Subjects of this rule's target class only — passes never cross types.
        const subjects = [...new Set(store.getQuads(null, RDF_TYPE, df.namedNode(rule.targetClass), MAPPED_GRAPH)
            .filter(qu => qu.subject.termType === "NamedNode")
            .map(qu => qu.subject.value))]

        const valOf = (s, pred) => {
            const qs = store.getQuads(df.namedNode(s), pred, null, MAPPED_GRAPH)
            return qs.length ? qs[0].object.value : null
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
                if (ha[i] == null || hb[i] == null || ha[i] !== hb[i]) return null
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
        for (const { a, b } of sameAsRows) {
            if (parent.has(a) && parent.has(b)) { union(a, b); sameAsUnions++; evidence.push({ a, b, manual: true }) }
        }

        // Grouping turns the O(n²) all-pairs scan into a per-bucket
        // O(Σ mᵢ²) one. The hard checks are redundant after bucketing, 
        // but introduces a cheap correctness check
        // buckets: a subject's bucket key is the JSON of its hard
        // value **tuple** (hardVals), so subjects sharing identical hard values
        // land in the same bucket. 
        const buckets = new Map()
        if (hard.length) {
            for (const s of subjects) {
                const hv = hardVals.get(s)
                if (hv.some(v => v == null)) continue
                const key = JSON.stringify(hv)
                if (!buckets.has(key)){
                    buckets.set(key, [])
                }
                buckets.get(key).push(s)
            }
        } else {
            buckets.set("", subjects)
        }

        for (const bucket of buckets.values()) {
            for (let i = 0; i < bucket.length; i++) {
                for (let j = i + 1; j < bucket.length; j++) {
                    const m = matches(bucket[i], bucket[j])
                    if (m) { union(bucket[i], bucket[j]); evidence.push({ a: bucket[i], b: bucket[j], ...m }) }
                }
            }
        }

        const clusters = new Map()
        for (const s of subjects) {
            const root = find(s)
            if (!clusters.has(root)) clusters.set(root, [])
            clusters.get(root).push(s)
        }
        const clusterMembers = [...clusters.values()]
            .map(m => [...m].sort())
            .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))

        let multiSource = 0
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
            for (const m of members) registry.set(m, minted.value)
            clusterIriByRoot.set(find(members[0]), minted)
            if (members.length > 1) multiSource++
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
                store.addQuad(df.quad(evNode, SIM_ALGORITHM, df.literal(SIMILARITY_ALGORITHM), MATCH_GRAPH))
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

        console.log(`match: ${rule.match.split("#").pop()} ${subjects.length} entities in ${buckets.size} bucket(s) → ${clusters.size} clusters (${multiSource} multi-source, ${sameAsUnions} sameAs unions)`)
    }

    const matchQuads = store.getQuads(null, null, null, MATCH_GRAPH)
    await writeTurtleFile(abs(outPath), matchQuads, { cdp: CDP, cdf: rules[0].ns, ...COMMON_PREFIXES })
    console.log(`match: wrote cluster log → ${outPath}`)

    await writeTurtleFile(abs(registryPath), [...registry].map(([member, minted]) =>
        df.quad(df.namedNode(minted), HAS_MEMBER, df.namedNode(member))), { cdp: CDP, cdf: rules[0].ns })
    console.log(`match: identity registry ${reusedCount} reused, ${mintedCount} minted → ${registryPath}`)

    // Append this run's events to the history (the registry's provenance) as
    // one :Revision node carrying the timestamp, with each event hung off it as
    // a nested [entity ; members] binding under a type predicate (cdp:minted /
    // cdp:memberJoined). Revisions count only changing runs — a no-op harvest
    // appends nothing — so the next number is one past the highest on file. The
    // whole block is one append, so the named :Revision and its fresh blank
    // nodes never collide with earlier revisions when the file is re-parsed.
    if (events.length) {
        const prefixes = { cdp: CDP, cdf: rules[0].ns }
        const sh   = (iri) => shrink(iri, prefixes)
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

        const header = `@prefix cdp:  <${CDP}> .
@prefix cdf:  <${rules[0].ns}> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .

`
        fs.appendFileSync(abs(historyPath), (existing ? "\n" : header) + block)
        console.log(`match: revision ${rev} — ${events.length} identity event(s) → ${historyPath}`)
    }
}
