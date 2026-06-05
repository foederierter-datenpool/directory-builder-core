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
