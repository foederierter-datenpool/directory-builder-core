// Builds the Merge view's per-source entity list.
// Directory uses its compact source index instead of opening this provenance.

import { loadMerge } from "./loadMerge.js"
import { isConflict } from "./EntityCard.jsx"
import { federationTtl, fetchTexts } from "./instanceData.js"
import { PATHS } from "@directory-builder/core/utils"

const conflictCount = (entity) => entity.fields.reduce((n, f) => n + (isConflict(f) ? 1 : 0), 0)

// Merge view sorts by conflict count, then IRI for stable browsing.
const [mergedTtl, provTtl] = await fetchTexts([PATHS.merged, PATHS.provenance])
export const mergedEntities = loadMerge(mergedTtl, provTtl, federationTtl).sort((a, b) => conflictCount(b) - conflictCount(a) || a.iri.localeCompare(b.iri))

// Merge entities carry their contributing Source IRIs on per-record columns.
for (const e of mergedEntities) e.sources = [...new Set(e.columns.map((c) => c.source).filter(Boolean))]
