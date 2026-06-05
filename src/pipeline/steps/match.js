import { sparqlSelect } from "@foerderfunke/sem-ops-utils"
import { COMMON_PREFIXES, writeTurtleFile } from "../write-turtle.js"
import { MAPPED_GRAPH } from "./map.js"
import { CDP } from "../../utils.js"
import { token_set_ratio } from "fuzzball"
import { DataFactory } from "n3"
import { createHash } from "crypto"

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
const SIMILARITY_ALGORITHM = "token_set_ratio"
const similarity = (a, b) => token_set_ratio(a ?? "", b ?? "") / 100

export const runMatch = async ({ store, defStore, abs }, outPath) => {
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

        for (let i = 0; i < subjects.length; i++) {
            for (let j = i + 1; j < subjects.length; j++) {
                const m = matches(subjects[i], subjects[j])
                if (m) { union(subjects[i], subjects[j]); evidence.push({ a: subjects[i], b: subjects[j], ...m }) }
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
            const id = createHash("sha1").update(members.join("|")).digest("hex").slice(0, 12)
            const minted = df.namedNode(namespace + mintedPrefix + id)
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

        console.log(`match: ${rule.match.split("#").pop()} ${subjects.length} entities → ${clusters.size} clusters (${multiSource} multi-source, ${sameAsUnions} sameAs unions)`)
    }

    const matchQuads = store.getQuads(null, null, null, MATCH_GRAPH)
    await writeTurtleFile(abs(outPath), matchQuads, { cdp: CDP, cdf: rules[0].ns, ...COMMON_PREFIXES })
    console.log(`match: wrote cluster log → ${outPath}`)
}
