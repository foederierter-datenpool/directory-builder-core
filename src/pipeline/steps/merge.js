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

// Each reified triple points to the source record that contributed it.
const PROV_DERIVED_FROM = df.namedNode(`${NAMESPACES.prov}wasDerivedFrom`)

// Shared derivations for the merged graph, provenance and browser chunks.
export function createMergeDerivations(store) {
    const members = new Map(), mintedFor = new Map()
    for (const { subject, object } of store.getQuads(null, HAS_MEMBER, null, MATCH_GRAPH)) {
        mintedFor.set(object.value, subject)
        if (!members.has(subject.value)) members.set(subject.value, [])
        members.get(subject.value).push(object)
    }
    const mergedQuadOf = (quad) => {
        const minted = mintedFor.get(quad.subject.value)
        if (!minted) return null
        // Rewrite links to matched records (e.g. schema:provider) to their cluster
        // IRIs, so relationships point to merged entities instead of source records.
        const object = quad.object.termType === "NamedNode" && mintedFor.has(quad.object.value)
            ? mintedFor.get(quad.object.value) : quad.object
        return df.quad(minted, quad.predicate, object)
    }
    const recordsFor = (iri) => {
        const records = new Map()
        for (const member of members.get(iri) ?? []) {
            for (const quad of store.getQuads(member, null, null, MAPPED_GRAPH)) {
                const merged = mergedQuadOf(quad)
                const key = `${merged.predicate.value}\t${merged.object.value}`
                if (!records.has(key)) records.set(key, new Set())
                records.get(key).add(member.value)
            }
        }
        return records
    }
    return { members, mergedQuadOf, recordsFor }
}

export const runMerge = async ({ store, defStore, abs }, outPath, provOutPath, sourceOutPath) => {
    const [cfg] = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?ns WHERE { ?match a :MatchRule ; :targetNamespace ?ns . }`, [defStore])
    if (!cfg) throw new Error(":MatchRule config missing in federation.ttl")
    const namespace = cfg.ns

    const { mergedQuadOf } = createMergeDerivations(store)

    // Compact entity-level source index for consumer views. The per-triple
    // provenance remains separate; Directory needs only these source labels.
    if (sourceOutPath) {
        const fromSource = df.namedNode(`${CDP}fromSource`)
        const sourceIndex = new Map()
        for (const { subject: minted, object: member } of store.getQuads(null, HAS_MEMBER, null, MATCH_GRAPH)) {
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
    for (const qu of fedQuads) {
        const merged = mergedQuadOf(qu)
        if (merged) store.addQuad(df.quad(merged.subject, merged.predicate, merged.object, MERGED_GRAPH))
    }

    const mergedQuads = store.getQuads(null, null, null, MERGED_GRAPH)

    await writeTurtleFile(abs(outPath), mergedQuads, { ...COMMON_PREFIXES, cdp: CDP, cdf: namespace })
    console.log(`merge: wrote ${mergedQuads.length} triples → ${outPath}`)

    let annotations = 0
    function* provenanceQuads() {
        for (const qu of fedQuads) {
            const merged = mergedQuadOf(qu)
            if (!merged) continue
            // RDF 1.2 provenance links each source record to a reified triple.
            const reifier = df.blankNode()
            annotations++
            yield df.quad(reifier, RDF_REIFIES, merged)
            yield df.quad(reifier, PROV_DERIVED_FROM, qu.subject)
        }
    }
    await writeTurtleFile(abs(provOutPath), provenanceQuads(),
        { ...COMMON_PREFIXES, cdp: CDP, cdf: namespace, ...prefixes("prov", "rdf") }, { dedupe: false })
    console.log(`merge: wrote ${annotations} provenance annotations → ${provOutPath}`)
}
