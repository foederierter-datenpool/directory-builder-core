import { sparqlSelect } from "@foerderfunke/sem-ops-utils"
import { COMMON_PREFIXES, writeTurtleFile } from "../write-turtle.js"
import { HAS_MEMBER, MATCH_GRAPH } from "./match.js"
import { MAPPED_GRAPH } from "./map.js"
import { CDP } from "../../utils.js"
import { DataFactory } from "n3"

const df = DataFactory

export const MERGED_GRAPH = df.namedNode("urn:merged")

const RDF_REIFIES = df.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies")

export const runMerge = async ({ store, defStore, abs }, outPath, provOutPath) => {
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
        // One reifier per derivation occurrence (RDF 1.2: triple terms are only
        // legal as objects, via rdf:reifies) — the provenance hangs off it, and
        // per-derivation metadata (time, confidence) has a home when needed.
        const reifier = df.blankNode()
        provQuads.push(df.quad(reifier, RDF_REIFIES, df.quad(minted, qu.predicate, object)))
        provQuads.push(df.quad(reifier, originPredNode, qu.subject))
    }

    const mergedQuads = store.getQuads(null, null, null, MERGED_GRAPH)

    await writeTurtleFile(abs(outPath), mergedQuads, { ...COMMON_PREFIXES, cdp: CDP, cdf: namespace })
    console.log(`merge: wrote ${mergedQuads.length} triples → ${outPath}`)

    await writeTurtleFile(abs(provOutPath), provQuads, {
        ...COMMON_PREFIXES, cdp: CDP, cdf: namespace, prov: "http://www.w3.org/ns/prov#",
        rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    })
    console.log(`merge: wrote ${provQuads.length / 2} provenance annotations → ${provOutPath}`)
}
