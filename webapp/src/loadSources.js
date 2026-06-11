// Helper for the Sources view: aggregate per-:Source facts (label, URL, format,
// field counts, record count, freshness) across config + pipeline data.
// Reads:  federation, mapped, ingest-log TTL strings passed by Sources.jsx
// Does:   returns source[] ({iri, label, format, totalFields, mappedFields, records, …})

import { CDP as NS, enabledSources, formatFamily, parseTtl, PATHS, sourceName } from "@directory-builder/core/utils"

const PROV_AT_TIME = "http://www.w3.org/ns/prov#atTime"
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label"

const setAdd = (map, key, val) => {
    if (!map.has(key)) map.set(key, new Set())
    map.get(key).add(val)
}

export function loadSources(federationTtl, mappedTtl, ingestLogTtl) {
    const fedQuads = parseTtl(federationTtl)
    const mappedQuads = mappedTtl ? parseTtl(mappedTtl) : []
    const logQuads = ingestLogTtl ? parseTtl(ingestLogTtl) : []

    const sourceIris = new Set(enabledSources(fedQuads))

    const props = new Map()
    const get = (iri) => {
        if (!props.has(iri)) props.set(iri, { iri })
        return props.get(iri)
    }

    // Source-level: label, top-level fields, sub-fields, mappings.
    const topFieldsOf = new Map()    // sourceIri (or entityIri) -> Set<fieldIri>
    const subFieldsOf = new Map()    // fieldIri  -> Set<subFieldIri>
    const entitiesOf  = new Map()    // sourceIri -> Set<entityIri>
    const mappingSource = new Map()  // mappingIri -> sourceIri
    const fmsOfMapping = new Map()   // mappingIri -> Set<fieldMappingBnode>
    const fromsOfFm = new Map()      // bnode      -> Set<fieldIri>

    for (const q of fedQuads) {
        const p = q.predicate.value
        if (p === RDFS_LABEL && sourceIris.has(q.subject.value))   get(q.subject.value).label = q.object.value
        else if (p === `${NS}fetchUrl` && sourceIris.has(q.subject.value))
                                               get(q.subject.value).fetchUrl = q.object.value
        else if (p === `${NS}format` && sourceIris.has(q.subject.value))
                                               get(q.subject.value).format = formatFamily(q.object.value)
        else if (p === `${NS}hasField`)        setAdd(topFieldsOf, q.subject.value, q.object.value)
        else if (p === `${NS}hasSubField`)     setAdd(subFieldsOf, q.subject.value, q.object.value)
        else if (p === `${NS}hasEntity`)       setAdd(entitiesOf, q.subject.value, q.object.value)
        else if (p === `${NS}fromSource`)      mappingSource.set(q.subject.value, q.object.value)
        else if (p === `${NS}hasFieldMapping`) setAdd(fmsOfMapping, q.subject.value, q.object.value)
        else if (p === `${NS}from`)            setAdd(fromsOfFm, q.subject.value, q.object.value)
    }

    for (const sourceIri of sourceIris) {
        const top = new Set(topFieldsOf.get(sourceIri) ?? [])
        for (const e of entitiesOf.get(sourceIri) ?? []) for (const f of topFieldsOf.get(e) ?? []) top.add(f)
        const all = new Set(top)
        for (const tf of top) for (const sf of subFieldsOf.get(tf) ?? []) all.add(sf)
        get(sourceIri).totalFields = all.size

        const mapped = new Set()
        for (const [mappingIri, srcIri] of mappingSource) {
            if (srcIri !== sourceIri) continue
            for (const fm of fmsOfMapping.get(mappingIri) ?? []) {
                for (const f of fromsOfFm.get(fm) ?? []) mapped.add(f)
            }
        }
        get(sourceIri).mappedFields = mapped.size
    }

    // Static-file sources (no :fetchUrl) read from the conventional static dir.
    for (const sourceIri of sourceIris) {
        if (!get(sourceIri).fetchUrl) get(sourceIri).staticSource = PATHS.staticDir(sourceName(sourceIri))
    }

    // Records: count distinct entities in mapped.ttl per source via cdp:fromSource.
    const FROM_SOURCE = `${NS}fromSource`
    const subjectsBySource = new Map()
    for (const q of mappedQuads) {
        if (q.predicate.value === FROM_SOURCE) setAdd(subjectsBySource, q.object.value, q.subject.value)
    }
    for (const sourceIri of sourceIris) {
        get(sourceIri).records = subjectsBySource.get(sourceIri)?.size ?? 0
    }

    // Latest harvest timestamp per source from ingest-log.ttl. Each :harvested
    // bnode carries (:ofSource ?source, prov:atTime ?time) and, for static-file
    // sources, the files' git commit time (:staticCommittedAt); find the max time.
    const harvestBnode = new Map()
    const harvest = (bnode) => {
        if (!harvestBnode.has(bnode)) harvestBnode.set(bnode, {})
        return harvestBnode.get(bnode)
    }
    for (const q of logQuads) {
        if (q.predicate.value === `${NS}ofSource`)                 harvest(q.subject.value).source = q.object.value
        else if (q.predicate.value === PROV_AT_TIME)               harvest(q.subject.value).time = q.object.value
        else if (q.predicate.value === `${NS}staticCommittedAt`)   harvest(q.subject.value).committedAt = q.object.value
    }
    for (const { source, time, committedAt } of harvestBnode.values()) {
        if (!source || !time || !sourceIris.has(source)) continue
        const cur = get(source).lastHarvestedAt
        if (!cur || time > cur) get(source).lastHarvestedAt = time
        if (committedAt) get(source).staticCommittedAt = committedAt
    }

    return [...sourceIris].map((iri) => get(iri))
}
