// Parses merged + provenance TTL into org objects: each field's values and the
// :Source(s) that contributed them, ordered by config. Pure (ttl in → data out).
// Reads:  TTL strings passed by mergeOrgs.js; resolves sources via sourceMeta.js
// Does:   returns org[] (each {iri, label, type, fields[], sources[]})

import { CDP as NS, parseTtl, shrink } from "@directory-builder/core/utils"
import { compareSources, loadSourceMeta } from "./sourceMeta.js"

const PROV_DERIVED_FROM = "http://www.w3.org/ns/prov#wasDerivedFrom"
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
const RDF_REIFIES = "http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies"
const FROM_SOURCE = `${NS}fromSource`

const PREFIXES = {
    schema: "http://schema.org/",
    dct:    "http://purl.org/dc/terms/",
    foaf:   "http://xmlns.com/foaf/0.1/",
    cdp:    NS,
    cdf:    "https://civic-data.de/federated-directory#",
}
const prefixedIri = (iri) => shrink(iri, PREFIXES)

export function loadMerge(mergedTtl, provTtl, federationTtl = "") {
    const mergedQuads = parseTtl(mergedTtl)
    const provQuads = parseTtl(provTtl)
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
    const orgs = []
    const orgIndex = new Map()
    const fieldIndexByOrg = new Map()
    for (const q of mergedQuads) {
        const orgIri = q.subject.value
        const predIri = q.predicate.value
        const value = q.object.value

        if (!orgIndex.has(orgIri)) {
            orgIndex.set(orgIri, orgs.length)
            fieldIndexByOrg.set(orgIri, new Map())
            orgs.push({ iri: orgIri, label: prefixedIri(orgIri), fields: [] })
        }
        const org = orgs[orgIndex.get(orgIri)]
        const fieldIndex = fieldIndexByOrg.get(orgIri)

        // rdf:type carries the entity class — surface it in the card header
        // (see OrgCard), not as a field row.
        if (predIri === RDF_TYPE) { org.type = prefixedIri(value); continue }

        if (!fieldIndex.has(predIri)) {
            fieldIndex.set(predIri, org.fields.length)
            org.fields.push({ predicate: predIri, predLabel: prefixedIri(predIri), values: [] })
        }
        const field = org.fields[fieldIndex.get(predIri)]
        const records = [...(provIndex.get(tripleKey(orgIri, predIri, value)) ?? [])]
        const sources = toSources(records)
        const displayValue = q.object.termType === "NamedNode" ? prefixedIri(value) : value
        field.values.push({ value: displayValue, raw: value, sources, records })
    }

    // Per-field: sort values by source-count desc so the most-supported one is index 0.
    // Per-org: one column per contributing record (two records from the same source
    // get two columns), ordered by source then record IRI.
    for (const org of orgs) {
        for (const f of org.fields) f.values.sort((a, b) => b.sources.length - a.sources.length)
        const all = new Set()
        for (const f of org.fields) for (const v of f.values) for (const r of v.records) all.add(r)
        org.columns = [...all].map((r) => ({ record: r, source: sourceOfRecord.get(r) }))
            .sort((a, b) => compareSources(a.source, b.source, sourceMeta) || a.record.localeCompare(b.record))
    }
    return orgs
}
