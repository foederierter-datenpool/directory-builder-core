// Builds the entity lists for the Merge and Directory views, in one shared order.
// Reads:  data/pipeline/{merged,provenance,final}.ttl, config/federation.ttl (via loadMerge.js)
// Does:   exports mergedEntities and finalEntities (consumed by MergeTables, Directory)

import { loadMerge } from "./loadMerge.js"
import { isConflict } from "./EntityCard.jsx"
import { federationTtl, provenanceTtl as provTtl, mergedTtl, finalTtl } from "./instanceData.js"

const conflictCount = (entity) => entity.fields.reduce((n, f) => n + (isConflict(f) ? 1 : 0), 0)

// Merge view sorts by conflict count desc; the directory mirrors that order
// so the same entity sits in the same visual slot across pages.
export const mergedEntities = loadMerge(mergedTtl, provTtl, federationTtl).sort((a, b) => conflictCount(b) - conflictCount(a) || a.iri.localeCompare(b.iri))
const orderIndex = new Map(mergedEntities.map((o, i) => [o.iri, i]))
export const finalEntities = loadMerge(finalTtl, "", federationTtl).sort((a, b) => (orderIndex.get(a.iri) ?? Infinity) - (orderIndex.get(b.iri) ?? Infinity))

// The :Sources that contributed to each entity (Source IRIs), for the source
// filter on the Merge and Directory pages. Merge entities carry it on their
// per-record columns; final entities load without provenance (single resolved
// values, no per-source columns), so they inherit it from the merged entity of
// the same canonical IRI.
for (const e of mergedEntities) e.sources = [...new Set(e.columns.map((c) => c.source).filter(Boolean))]
const sourcesByIri = new Map(mergedEntities.map((e) => [e.iri, e.sources]))
for (const e of finalEntities) e.sources = sourcesByIri.get(e.iri) ?? []
