import { sparqlSelect } from "@foerderfunke/sem-ops-utils"
import { COMMON_PREFIXES, writeTurtleFile } from "../write-turtle.js"
import { HAS_MEMBER, MATCH_GRAPH } from "./match.js"
import { MAPPED_GRAPH } from "./map.js"
import { CDP, NAMESPACES, prefixes } from "../../utils.js"
import { DataFactory } from "n3"
import fs from "node:fs"
import path from "node:path"

const df = DataFactory

export const MERGED_GRAPH = df.namedNode("urn:merged")

const RDF_REIFIES = df.namedNode(`${NAMESPACES.rdf}reifies`)

// Engine invariant, mirrored by the webapp's loadMerge: each derivation's
// origin hangs off its reifier via prov:wasDerivedFrom.
const PROV_DERIVED_FROM = df.namedNode(`${NAMESPACES.prov}wasDerivedFrom`)

export const runMerge = async ({ store, defStore, abs }, outPath, provOutPath, sourceOutPath) => {
    const [cfg] = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?ns WHERE { ?match a :MatchRule ; :targetNamespace ?ns . }`, [defStore])
    if (!cfg) throw new Error(":MatchRule config missing in federation.ttl")
    const namespace = cfg.ns

    const memberQuads = store.getQuads(null, HAS_MEMBER, null, MATCH_GRAPH)
    const mintedFor = new Map()
    for (const mq of memberQuads) mintedFor.set(mq.object.value, mq.subject)

    // Compact entity-level source index for consumer views. The per-triple
    // provenance remains separate; Directory needs only these source labels.
    if (sourceOutPath) {
        const fromSource = df.namedNode(`${CDP}fromSource`)
        const sourceIndex = new Map()
        for (const { subject: minted, object: member } of memberQuads) {
            const sources = store.getQuads(member, fromSource, null, MAPPED_GRAPH)
            if (!sourceIndex.has(minted.value)) sourceIndex.set(minted.value, new Set())
            for (const source of sources) sourceIndex.get(minted.value).add(source.object.value)
        }
        const entries = [...sourceIndex].sort(([a], [b]) => a.localeCompare(b))
            .map(([entity, sources]) => [entity, [...sources].sort()])
        fs.mkdirSync(path.dirname(abs(sourceOutPath)), { recursive: true })
        fs.writeFileSync(abs(sourceOutPath), `${JSON.stringify(Object.fromEntries(entries))}\n`)
        console.log(`merge: wrote source index for ${entries.length} entities → ${sourceOutPath}`)
    }

    const fedQuads = store.getQuads(null, null, null, MAPPED_GRAPH)
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
        // One reifier per derivation occurrence (RDF 1.2: triple terms are only
        // legal as objects, via rdf:reifies) — the provenance hangs off it, and
        // per-derivation metadata (time, confidence) has a home when needed.
        const reifier = df.blankNode()
        provQuads.push(df.quad(reifier, RDF_REIFIES, df.quad(minted, qu.predicate, object)))
        provQuads.push(df.quad(reifier, PROV_DERIVED_FROM, qu.subject))
    }

    const mergedQuads = store.getQuads(null, null, null, MERGED_GRAPH)

    await writeTurtleFile(abs(outPath), mergedQuads, { ...COMMON_PREFIXES, cdp: CDP, cdf: namespace })
    console.log(`merge: wrote ${mergedQuads.length} triples → ${outPath}`)

    await writeTurtleFile(abs(provOutPath), provQuads,
        { ...COMMON_PREFIXES, cdp: CDP, cdf: namespace, ...prefixes("prov", "rdf") })
    console.log(`merge: wrote ${provQuads.length / 2} provenance annotations → ${provOutPath}`)
}
