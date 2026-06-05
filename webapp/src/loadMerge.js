// Parses merged + provenance TTL into entity objects: each field's values and the
// :Source(s) that contributed them, ordered by config. Pure (ttl in → data out).
// Reads:  TTL strings passed by mergeEntities.js; resolves sources via sourceMeta.js
// Does:   returns entity[] (each {iri, label, type, fields[], sources[]})

import { CDP as NS, parseTtl, parseTtlStar, prefixesOf, shrink } from "@directory-builder/core/utils"
import { compareSources, loadSourceMeta } from "./sourceMeta.js"

const PROV_DERIVED_FROM = "http://www.w3.org/ns/prov#wasDerivedFrom"
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
const RDF_REIFIES = "http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies"
const FROM_SOURCE = `${NS}fromSource`

export function loadMerge(mergedTtl, provTtl, federationTtl = "") {
    // IRIs render shortened against the federation's own @prefix declarations.
    const prefixes = { cdp: NS, ...prefixesOf(federationTtl) }
    const prefixedIri = (iri) => shrink(iri, prefixes)
    const mergedQuads = parseTtl(mergedTtl)
    const provQuads = parseTtlStar(provTtl)
    const sourceMeta = federationTtl ? loadSourceMeta(federationTtl) : new Map()

    // Each prov:wasDerivedFrom in provenance.ttl annotates a merged triple
    // `<<s p o>>` with the source record IRI it came from. n3.js exposes the
    // quoted-triple subject either directly as a Quad term, or via an
    // auto-generated reifier bnode + rdf:reifies triple — accept both shapes.
    const reifies = new Map()
    for (const q of provQuads) {
        if (q.predicate.value === RDF_REIFIES && q.object.termType === "Quad") reifies.set(q.subject.value, q.object)
    }
    const annotations = []
    for (const q of provQuads) {
        if (q.predicate.value !== PROV_DERIVED_FROM) continue
        const t = q.subject.termType === "Quad" ? q.subject : reifies.get(q.subject.value)
        if (t) annotations.push({ s: t.subject.value, p: t.predicate.value, o: t.object.value, rec: q.object.value })
    }
    // Resolve each record to its :Source via cdp:fromSource (reified in
    // provenance) so downstream code deals only in Source IRIs, not record IRIs.
    const sourceOfRecord = new Map()
    for (const { p, o, rec } of annotations) if (p === FROM_SOURCE) sourceOfRecord.set(rec, o)
    const toSources = (records) => [...new Set([...records].map((r) => sourceOfRecord.get(r)))]

    const provIndex = new Map()
    const tripleKey = (s, p, o) => `${s}\t${p}\t${o}`
    for (const { s, p, o, rec } of annotations) {
        const key = tripleKey(s, p, o)
        if (!provIndex.has(key)) provIndex.set(key, new Set())
        provIndex.get(key).add(rec)
    }

    // Walk merged.ttl in parse order so card order = pipeline order.
    const entities = []
    const entityIndex = new Map()
    const fieldIndexByEntity = new Map()
    for (const q of mergedQuads) {
        const entityIri = q.subject.value
        const predIri = q.predicate.value
        const value = q.object.value

        if (!entityIndex.has(entityIri)) {
            entityIndex.set(entityIri, entities.length)
            fieldIndexByEntity.set(entityIri, new Map())
            entities.push({ iri: entityIri, label: prefixedIri(entityIri), fields: [] })
        }
        const entity = entities[entityIndex.get(entityIri)]
        const fieldIndex = fieldIndexByEntity.get(entityIri)

        // rdf:type carries the entity class — surface it in the card header
        // (see EntityCard), not as a field row.
        if (predIri === RDF_TYPE) { entity.type = prefixedIri(value); continue }

        if (!fieldIndex.has(predIri)) {
            fieldIndex.set(predIri, entity.fields.length)
            entity.fields.push({ predicate: predIri, predLabel: prefixedIri(predIri), values: [] })
        }
        const field = entity.fields[fieldIndex.get(predIri)]
        const records = [...(provIndex.get(tripleKey(entityIri, predIri, value)) ?? [])]
        const sources = toSources(records)
        const displayValue = q.object.termType === "NamedNode" ? prefixedIri(value) : value
        field.values.push({ value: displayValue, raw: value, sources, records })
    }

    // Per-field: sort values by source-count desc so the most-supported one is index 0.
    // Per-entity: one column per contributing record (two records from the same source
    // get two columns), ordered by source then record IRI.
    for (const entity of entities) {
        for (const f of entity.fields) f.values.sort((a, b) => b.sources.length - a.sources.length)
        const all = new Set()
        for (const f of entity.fields) for (const v of f.values) for (const r of v.records) all.add(r)
        entity.columns = [...all].map((r) => ({ record: r, source: sourceOfRecord.get(r) }))
            .sort((a, b) => compareSources(a.source, b.source, sourceMeta) || a.record.localeCompare(b.record))
    }
    return entities
}
