import { newStore, parser as n3Parser, sparqlConstruct, sparqlInsertDelete, sparqlSelect, storeFromTurtles } from "@foerderfunke/sem-ops-utils"
import { buildPrefixBlock, CDP, objectsOf, parseTtl, PATHS, shrink, sourceGraph, sourceName, stepIri, stepJournal } from "./utils.js"
import { token_set_ratio } from "fuzzball"
import { DataFactory, Writer } from "n3"
import { createHash } from "crypto"
import path from "path"
import fs from "fs"

const df = DataFactory

// Dedupe via a Store and sort by subject so the Writer can emit grouped
// "subject p1 o1; p2 o2." blocks instead of repeating subjects. Strips
// graph names (writes triples, not quads).
const writeTurtleFile = (filePath, quads, prefixes = {}) => new Promise((resolve, reject) => {
    const store = newStore()
    for (const q of quads) store.addQuad(df.quad(q.subject, q.predicate, q.object))
    const dedup = store.getQuads(null, null, null, null)
        .sort((a, b) => a.subject.value.localeCompare(b.subject.value))
    const writer = new Writer({ prefixes })
    for (const q of dedup) writer.addQuad(q)
    writer.end((err, result) => {
        if (err) return reject(err)
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, result)
        resolve()
    })
})

// ---- Direct-mapping generator ------------------------------------------

const XYZ = "http://sparql.xyz/facade-x/data/"

const buildDirectInsert = ({ sourceGraph, source, targetClass, target }, fields) => {
    const prefixes = {
        xyz:    XYZ,
        cdp:    CDP,
        cdf:    "https://civic-data.de/federated-directory#",
        schema: "http://schema.org/",
        foaf:   "http://xmlns.com/foaf/0.1/",
        dct:    "http://purl.org/dc/terms/",
    }
    // shrink() returns the IRI verbatim if no prefix matches; wrap that as <…>.
    const short = (iri) => {
        const s = shrink(iri, prefixes)
        return s === iri ? `<${iri}>` : s
    }

    const v      = (path) => `?${path}`
    // STR() before the emptiness check so the guard works for any literal
    // datatype — a bare `?v != ""` errors on e.g. xsd:int and would silently
    // drop the field (AWO's numeric ids hit exactly this).
    const optLit = (subj, path) =>
        `OPTIONAL { ${subj} xyz:${path} ${v(path)} . ` +
        `FILTER(isLiteral(${v(path)}) && STR(${v(path)}) != "") }`

    const insertBlock = fields
        .map(f => `        ?org ${short(f.predicate)} ${v(f.fieldPath)} .`)
        .join("\n")

    const topLevel  = fields.filter(f => !f.parentPath)
    const subFields = fields.filter(f => f.parentPath)

    // Source subjects = federation IRIs after the clean step, identified via
    // cdp:fromSource — no minting from a key field. Where clean reshapes one
    // source into several entity kinds it tags each subject with cdp:targetSchema;
    // select only those for this mapping's schema. Subjects with no marker
    // (single-entity sources like caritas/dhs) match unconditionally.
    const bgp = [`?org cdp:fromSource ${short(source)} .`]
    if (target) {
        bgp.push(`OPTIONAL { ?org cdp:targetSchema ?_ts }`)
        bgp.push(`FILTER(!bound(?_ts) || ?_ts = ${short(target)})`)
    }
    for (const f of topLevel) bgp.push(optLit("?org", f.fieldPath))

    const byParent = new Map()
    for (const f of subFields) {
        if (!byParent.has(f.parentPath)) byParent.set(f.parentPath, [])
        byParent.get(f.parentPath).push(f)
    }
    let parentIdx = 0
    for (const [parent, subs] of byParent) {
        const pv    = `?_p${parentIdx++}`
        const inner = subs.map(s => `    ${optLit(pv, s.fieldPath)}`).join("\n")
        bgp.push(`OPTIONAL {\n    ?org xyz:${parent} ${pv} .\n${inner}\n  }`)
    }

    // The target schema's :targetClass becomes the record's rdf:type here in the
    // mapped graph — this is where schema: vocabulary first enters; the clean step
    // stays in xyz:/cdp: only.
    const typeClause = targetClass ? `a ${short(targetClass)} ; ` : ""

    return `${buildPrefixBlock(prefixes)}

INSERT {
    GRAPH <urn:mapped> {
        ?org ${typeClause}cdp:fromSource ${short(source)} .
${insertBlock}
    }
} WHERE {
    GRAPH <${sourceGraph}> {
        ${bgp.join("\n        ")}
    }
}`
}

const runMap = async ({ store, defStore, abs }, queriesDir) => {
    const mappings = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?mapping ?source ?sourceGraph ?target ?targetClass WHERE {
            ?mapping a :Mapping ;
                :fromSource ?source .
            OPTIONAL { ?mapping :sourceGraph ?sourceGraph }
            OPTIONAL { ?mapping :toTarget ?target }
            OPTIONAL { ?mapping :toTarget/:targetClass ?targetClass }
        } ORDER BY ?mapping`, [defStore])

    for (const m of mappings) {
        const directRows = await sparqlSelect(`
            PREFIX : <${CDP}>
            SELECT ?fieldPath ?predicate ?parentPath WHERE {
                <${m.mapping}> :hasFieldMapping ?fm .
                ?fm :from ?src ; :to ?tgt .
                FILTER NOT EXISTS { ?fm :via ?_v }
                ?tgt :targetPredicate ?predicate .
                ?src :fieldPath ?fieldPath .
                OPTIONAL { ?parent :hasSubField ?src . ?parent :fieldPath ?parentPath }
            }`, [defStore])

        if (directRows.length && m.sourceGraph) {
            const localName = m.mapping.split("#").pop()
            const query = buildDirectInsert(m, directRows)
            const queryPath = abs(path.join(queriesDir, `${localName}.sparql`))
            fs.mkdirSync(path.dirname(queryPath), { recursive: true })
            fs.writeFileSync(queryPath, query)
            console.log(`map  ${localName} direct (${directRows.length} mappings) → ${queryPath}`)
            await sparqlInsertDelete(query, store)
        }

        // :via names a transform of the mapping's source — the script path
        // follows by convention (sources/<source>/transform-<via>.sparql).
        const viaRows = await sparqlSelect(`
            PREFIX : <${CDP}>
            SELECT DISTINCT ?via WHERE {
                <${m.mapping}> :hasFieldMapping/:via ?via .
            } ORDER BY ?via`, [defStore])

        for (const v of viaRows) {
            const script = PATHS.transform(sourceName(m.source), v.via)
            console.log(`map  ${script}`)
            await sparqlInsertDelete(fs.readFileSync(abs(script), "utf8"), store)
        }
    }

    // A mapping's :hasRelationship turns the clean step's source-level link
    // (e.g. :providedBy) into a target predicate (schema:provider), matching the
    // two ends by their cdp:targetSchema. Both ends are still source IRIs here;
    // the merge step rewrites them to the minted cluster IRIs.
    const linkRows = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?mapping ?sourceGraph ?fromSchema ?sourcePredicate ?targetPredicate ?toSchema WHERE {
            ?mapping a :Mapping ;
                :sourceGraph     ?sourceGraph ;
                :toTarget        ?fromSchema ;
                :hasRelationship ?rel .
            ?rel :sourcePredicate ?sourcePredicate ;
                 :toTargetField   ?field ;
                 :toTargetSchema  ?toSchema .
            ?field :targetPredicate ?targetPredicate .
        } ORDER BY ?mapping`, [defStore])

    for (const rel of linkRows) {
        const prefixes = { cdp: CDP, schema: "http://schema.org/" }
        const short = (iri) => { const s = shrink(iri, prefixes); return s === iri ? `<${iri}>` : s }
        const query = `${buildPrefixBlock(prefixes)}

INSERT {
    GRAPH <urn:mapped> {
        ?from ${short(rel.targetPredicate)} ?to .
    }
} WHERE {
    GRAPH <${rel.sourceGraph}> {
        ?from ${short(rel.sourcePredicate)} ?to ;
              cdp:targetSchema ${short(rel.fromSchema)} .
        ?to cdp:targetSchema ${short(rel.toSchema)} .
    }
}`
        console.log(`map  ${rel.mapping.split("#").pop()} link (${short(rel.targetPredicate)})`)
        await sparqlInsertDelete(query, store)
    }
}

// ---- Shared graphs and prefixes ----------------------------------------

const MAPPED_GRAPH = df.namedNode("urn:mapped")
const MATCH_GRAPH  = df.namedNode("urn:matched")
const MERGED_GRAPH = df.namedNode("urn:merged")

const HAS_MEMBER = df.namedNode(CDP + "hasMember")

const COMMON_PREFIXES = {
    schema: "http://schema.org/",
    foaf:   "http://xmlns.com/foaf/0.1/",
    dct:    "http://purl.org/dc/terms/",
}

// ---- Match -------------------------------------------------------------

const RDF_TYPE      = df.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
const MATCH_CLUSTER = df.namedNode(CDP + "MatchCluster")

// token_set_ratio computes a ratio over the intersection of token sets, which
// is robust to legal-form noise ("gGmbH", "e.V."), sub-unit specifiers, and
// word-order variations. Returns 0–100; we normalise to 0–1. The algorithm
// name is recorded in the evidence graph so old similarity numbers stay
// interpretable across algorithm swaps.
const SIMILARITY_ALGORITHM = "token_set_ratio"
const similarity = (a, b) => token_set_ratio(a ?? "", b ?? "") / 100

const runMatch = async ({ store, defStore, abs }, outPath) => {
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

// ---- Merge -------------------------------------------------------------

const runMerge = async ({ store, defStore, abs }, outPath, provOutPath) => {
    const [cfg] = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?ns ?originPred WHERE {
            ?match a :MatchRule ; :targetNamespace ?ns .
            ?merge a :MergeRule ; :originPredicate ?originPred .
        }`, [defStore])
    if (!cfg) throw new Error(":MergeRule / :MatchRule config missing in federation.ttl")
    const { ns: namespace, originPred } = cfg

    const memberQuads = store.getQuads(null, HAS_MEMBER, null, MATCH_GRAPH)
    const mintedFor = new Map()
    for (const mq of memberQuads) mintedFor.set(mq.object.value, mq.subject)

    const fedQuads = store.getQuads(null, null, null, MAPPED_GRAPH)
    const originPredNode = df.namedNode(originPred)
    const provQuads = []
    for (const qu of fedQuads) {
        const minted = mintedFor.get(qu.subject.value)
        if (!minted) continue
        // Rewrite IRI objects that are themselves matched subjects to their minted
        // cluster IRI, so inter-entity links (e.g. schema:provider) point at the
        // merged entity rather than the pre-merge source IRI.
        const object = qu.object.termType === "NamedNode" && mintedFor.has(qu.object.value)
            ? mintedFor.get(qu.object.value)
            : qu.object
        store.addQuad(df.quad(minted, qu.predicate, object, MERGED_GRAPH))
        const triple = df.quad(minted, qu.predicate, object)
        provQuads.push(df.quad(triple, originPredNode, qu.subject))
    }

    const mergedQuads = store.getQuads(null, null, null, MERGED_GRAPH)

    await writeTurtleFile(abs(outPath), mergedQuads, { ...COMMON_PREFIXES, cdp: CDP, cdf: namespace })
    console.log(`merge: wrote ${mergedQuads.length} triples → ${outPath}`)

    await writeTurtleFile(abs(provOutPath), provQuads, {
        ...COMMON_PREFIXES, cdp: CDP, cdf: namespace, prov: "http://www.w3.org/ns/prov#",
    })
    console.log(`merge: wrote ${provQuads.length} provenance annotations → ${provOutPath}`)
}

// ---- Resolve -----------------------------------------------------------

// One value per (subject, predicate). schema:identifier and cdp:fromSource
// are dropped — final.ttl is the consumer-facing artifact, source attribution
// lives in provenance.ttl.
const STRATEGIES = {
    alphabeticFirst: (quads) => [...quads].sort((a, b) => a.object.value.localeCompare(b.object.value))[0],
    concatenateAll:  (quads) => df.quad(quads[0].subject, quads[0].predicate,
        df.literal([...new Set(quads.map(q => q.object.value))].sort().join(", "))),
}
const RESOLVE_EXCLUDE = new Set(["http://schema.org/identifier", `${CDP}fromSource`])

const lookupStrategy = (iri) => {
    const fn = STRATEGIES[iri.split("#").pop()]
    if (!fn) throw new Error(`Unknown resolve strategy ${iri}`)
    return fn
}

const runResolve = async ({ store, defStore, abs }, outPath) => {
    const [cfg] = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?strategy ?ns WHERE {
            ?resolve a :ResolveRule ; :defaultStrategy ?strategy .
            ?match   a :MatchRule   ; :targetNamespace ?ns .
        }`, [defStore])
    if (!cfg) throw new Error(":ResolveRule config missing in federation.ttl")
    const defaultPick = lookupStrategy(cfg.strategy)

    const overrideRows = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?on ?strategy WHERE {
            ?resolve a :ResolveRule ; :hasOverride [ :on ?on ; :strategy ?strategy ] .
        }`, [defStore])
    const overrides = new Map(overrideRows.map(r => [r.on, lookupStrategy(r.strategy)]))

    const groups = new Map()
    for (const q of store.getQuads(null, null, null, MERGED_GRAPH)) {
        if (RESOLVE_EXCLUDE.has(q.predicate.value)) continue
        const k = `${q.subject.value}\t${q.predicate.value}`
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(q)
    }
    const finalQuads = [...groups.values()].map(quads =>
        (overrides.get(quads[0].predicate.value) ?? defaultPick)(quads))

    await writeTurtleFile(abs(outPath), finalQuads, { ...COMMON_PREFIXES, cdf: cfg.ns })
    console.log(`resolve: wrote ${finalQuads.length} triples → ${outPath}`)
}

// ---- Federate engine -----------------------------------------------------
// Clean per source, load, then map → match → merge → resolve. The step
// sequence is the engine's own shape; config declares only the sources,
// processed in :hasSource declaration order. Paths follow from the source
// name (PATHS), resolved against the instance `root`. Each step runs through
// the journal, which records what executed and is rendered by the webapp's
// Pipeline page. The clean steps' predecessors are the other engine's lift
// steps, referenced by their conventional stepIri.

export async function federate(root = process.cwd()) {
    const abs = (p) => path.join(root, p)
    const federationTtl = fs.readFileSync(abs(PATHS.federation), "utf8")
    const defStore = storeFromTurtles([federationTtl, fs.readFileSync(abs(PATHS.matchKnowledge), "utf8")])
    const sources = objectsOf(parseTtl(federationTtl), `${CDP}hasSource`)

    const store = newStore()
    const journal = stepJournal()
    const ctx = { store, defStore, abs }

    const cleanSteps = []
    for (const src of sources) {
        const name = sourceName(src)
        cleanSteps.push(await journal.step("clean", { source: src, after: [stepIri("lift", name)] }, async () => {
            const cleanQuery = fs.readFileSync(abs(PATHS.cleanQuery(name)), "utf8")
            const inDir = PATHS.lifted(name)
            const outPath = PATHS.cleaned(name)
            // Run CONSTRUCT per file so each lifted TTL stays isolated in its
            // own store — the clean SPARQL can't cross-join across documents.
            const inAbs = abs(inDir)
            const files = fs.readdirSync(inAbs).filter(f => f.endsWith(".ttl")).sort()
            console.log(`clean  ${inDir} (${files.length} files) → ${outPath}`)
            const allQuads = []
            for (const f of files) {
                const fileStore = storeFromTurtles([fs.readFileSync(path.join(inAbs, f), "utf8")])
                allQuads.push(...await sparqlConstruct(cleanQuery, [fileStore]))
            }
            await writeTurtleFile(abs(outPath), allQuads, {
                xyz: "http://sparql.xyz/facade-x/data/",
                cdp: CDP,
            })
        }))
    }

    // Load each source's cleaned TTL into its own graph — plain mechanics, not a
    // pipeline step.
    for (const src of sources) {
        const name = sourceName(src)
        console.log(`load   ${PATHS.cleaned(name)} → <${sourceGraph(name)}>`)
        const graph = df.namedNode(sourceGraph(name))
        for (const quad of n3Parser.parse(fs.readFileSync(abs(PATHS.cleaned(name)), "utf8"))) {
            store.addQuad(df.quad(quad.subject, quad.predicate, quad.object, graph))
        }
    }

    const mapStep = await journal.step("map", { after: cleanSteps }, async () => {
        await runMap(ctx, PATHS.mappingQueries)
        const mappedQuads = store.getQuads(null, null, null, MAPPED_GRAPH)
        await writeTurtleFile(abs(PATHS.mapped), mappedQuads, { ...COMMON_PREFIXES, cdp: CDP })
        console.log(`map: wrote ${mappedQuads.length} triples → ${PATHS.mapped}`)
    })
    const matchStep   = await journal.step("match",   { after: [mapStep] },   () => runMatch(ctx, PATHS.matches))
    const mergeStep   = await journal.step("merge",   { after: [matchStep] }, () => runMerge(ctx, PATHS.merged, PATHS.provenance))
    await journal.step("resolve", { after: [mergeStep] }, () => runResolve(ctx, PATHS.final))

    fs.writeFileSync(abs(PATHS.federateLog), `@prefix :      <${CDP}> .
@prefix p-plan: <http://purl.org/net/p-plan#> .

${journal.toTurtle()}
`)
    console.log(`log:   wrote steps → ${PATHS.federateLog}`)
}
