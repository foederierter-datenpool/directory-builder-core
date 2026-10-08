// Loads Merge cards from the complete RDF snapshot.
import { CDP as NS, NAMESPACES, parseTtl, prefixesOf } from "@directory-builder/core/utils"
import { buildMergeEntities, loadSourceMeta } from "@directory-builder/core/merge-view"

const PROV_DERIVED_FROM = `${NAMESPACES.prov}wasDerivedFrom`
const RDF_REIFIES = `${NAMESPACES.rdf}reifies`
const FROM_SOURCE = `${NS}fromSource`

export function loadMerge(mergedTtl, provTtl, federationTtl = "") {
    const mergedQuads = parseTtl(mergedTtl)
    const provQuads = parseTtl(provTtl)

    // provenance.ttl is RDF 1.2 reification: one reifier per derivation
    // (`_:r rdf:reifies <<( s p o )>> ; prov:wasDerivedFrom record`).
    const reifies = new Map()
    for (const q of provQuads) {
        if (q.predicate.value === RDF_REIFIES && q.object.termType === "Quad") reifies.set(q.subject.value, q.object)
    }
    const annotations = []
    for (const q of provQuads) {
        if (q.predicate.value !== PROV_DERIVED_FROM) continue
        const t = reifies.get(q.subject.value)
        if (t) annotations.push({ s: t.subject.value, p: t.predicate.value, o: t.object.value, rec: q.object.value })
    }
    // Resolve each record to its :Source via cdp:fromSource (reified in
    // provenance) so downstream code deals only in Source IRIs, not record IRIs.
    const sourceOfRecord = new Map()
    for (const { p, o, rec } of annotations) if (p === FROM_SOURCE) sourceOfRecord.set(rec, o)
    const provIndex = new Map()
    const tripleKey = (s, p, o) => `${s}\t${p}\t${o}`
    for (const { s, p, o, rec } of annotations) {
        const key = tripleKey(s, p, o)
        if (!provIndex.has(key)) provIndex.set(key, new Set())
        provIndex.get(key).add(rec)
    }

    return buildMergeEntities(mergedQuads, {
        prefixes: { cdp: NS, ...prefixesOf(federationTtl) },
        sourceMeta: federationTtl ? loadSourceMeta(federationTtl) : new Map(),
        sourceOfRecord,
        recordsFor: (s, p, o) => [...(provIndex.get(tripleKey(s, p, o)) ?? [])],
    })
}
