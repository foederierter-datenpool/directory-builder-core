// Source metadata and links to harvested and extracted data.
export { loadSourceMeta, compareSources } from "@directory-builder/core/merge-view"
import { CDP as NS, NAMESPACES, parseTtl, PATHS, sourceName } from "@directory-builder/core/utils"

const PROV_AT_TIME  = `${NAMESPACES.prov}atTime`
const FROM_SOURCE   = `${NS}fromSource`
const OF_SOURCE     = `${NS}ofSource`

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

// Map<SourceIRI, extracted-TTL raw string> for every source a :Mapping draws
// from (:fromSource); the file is the conventional extracted path's basename.
// `rawByPath` comes from import.meta.glob(".../extracted/*.ttl", ...).
export function loadExtractedBySource(federationTtl, rawByPath) {
    const basename = (p) => p.split("/").pop()
    const rawByBase = new Map(Object.entries(rawByPath).map(([path, raw]) => [basename(path), raw]))

    const out = new Map()
    for (const q of parseTtl(federationTtl)) {
        if (q.predicate.value !== FROM_SOURCE) continue
        const raw = rawByBase.get(basename(PATHS.extracted(sourceName(q.object.value))))
        if (raw) out.set(q.object.value, raw)
    }
    return out
}
