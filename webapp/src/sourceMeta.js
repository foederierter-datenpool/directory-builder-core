// Source identity lives in config: federation.ttl declares each :Source (label,
// skos:notation, order); its cleaned-data file follows from the source name by
// the PATHS conventions. JS never hardcodes a source name — it resolves records
// to a :Source via cdp:fromSource.
// Reads:  TTL strings passed in (federation, mapped, ingest-log)
// Does:   returns lookup maps + helpers (used by loadMerge, OrgCard, MapGraph, MatchGraph)

import { CDP as NS, parseTtl, PATHS, sourceName } from "@directory-builder/core/utils"

const RDFS_LABEL    = "http://www.w3.org/2000/01/rdf-schema#label"
const SKOS_NOTATION = "http://www.w3.org/2004/02/skos/core#notation"
const PROV_AT_TIME  = "http://www.w3.org/ns/prov#atTime"
const HAS_SOURCE    = `${NS}hasSource`
const FROM_SOURCE   = `${NS}fromSource`
const OF_SOURCE     = `${NS}ofSource`

// Map<SourceIRI, {iri, label, notation, order}> from federation.ttl; order
// follows the :hasSource list. Assumes each :Source has a label and notation.
export function loadSourceMeta(federationTtl) {
    const order = new Map()
    const labelOf = new Map()
    const notationOf = new Map()
    let n = 0
    for (const q of parseTtl(federationTtl)) {
        const p = q.predicate.value
        if      (p === HAS_SOURCE && !order.has(q.object.value)) order.set(q.object.value, n++)
        else if (p === RDFS_LABEL)    labelOf.set(q.subject.value, q.object.value)
        else if (p === SKOS_NOTATION) notationOf.set(q.subject.value, q.object.value)
    }
    const meta = new Map()
    for (const iri of order.keys()) {
        meta.set(iri, { iri, label: labelOf.get(iri), notation: notationOf.get(iri), order: order.get(iri) })
    }
    return meta
}

// Order two Source IRIs by their federation declaration order, then IRI.
export function compareSources(a, b, meta) {
    const oa = meta.get(a).order
    const ob = meta.get(b).order
    return oa !== ob ? oa - ob : a.localeCompare(b)
}

// Map<recordIri, SourceIRI> from plain cdp:fromSource triples (mapped.ttl).
export function loadSourceOfRecord(ttl) {
    const out = new Map()
    for (const q of parseTtl(ttl)) if (q.predicate.value === FROM_SOURCE) out.set(q.subject.value, q.object.value)
    return out
}

// Map<SourceIRI, latest ISO timestamp> from the ingest log's harvest entries.
export function loadHarvestBySource(logTtl) {
    const source = new Map()
    const time = new Map()
    for (const q of parseTtl(logTtl)) {
        if      (q.predicate.value === OF_SOURCE)    source.set(q.subject.value, q.object.value)
        else if (q.predicate.value === PROV_AT_TIME) time.set(q.subject.value, q.object.value)
    }
    const out = new Map()
    for (const [bnode, src] of source) {
        const t = time.get(bnode)
        if (t && (!out.has(src) || t > out.get(src))) out.set(src, t)
    }
    return out
}

// Map<SourceIRI, cleaned-TTL raw string> for every source a :Mapping draws
// from (:fromSource); the file is the conventional cleaned path's basename.
// `rawByPath` comes from import.meta.glob(".../cleaned/*.ttl", ...).
export function loadCleanedBySource(federationTtl, rawByPath) {
    const basename = (p) => p.split("/").pop()
    const rawByBase = new Map(Object.entries(rawByPath).map(([path, raw]) => [basename(path), raw]))

    const out = new Map()
    for (const q of parseTtl(federationTtl)) {
        if (q.predicate.value !== FROM_SOURCE) continue
        const raw = rawByBase.get(basename(PATHS.cleaned(sourceName(q.object.value))))
        if (raw) out.set(q.object.value, raw)
    }
    return out
}
