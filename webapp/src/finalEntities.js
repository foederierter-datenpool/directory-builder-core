// Directory reads the resolved graph and a compact source index. Older
// snapshots without the index still work by deriving it from merge provenance.
import { loadMerge } from "./loadMerge.js"
import { federationTtl, fetchTexts } from "./instanceData.js"
import { PATHS } from "@directory-builder/core/utils"

const [finalTtl, indexText] = await fetchTexts([PATHS.final, PATHS.entitySources])
const sourcesByIri = indexText ? new Map(Object.entries(JSON.parse(indexText))) : new Map()
if (!indexText) {
    const [mergedTtl, provTtl] = await fetchTexts([PATHS.merged, PATHS.provenance])
    for (const entity of loadMerge(mergedTtl, provTtl, federationTtl))
        sourcesByIri.set(entity.iri, [...new Set(entity.columns.map(c => c.source).filter(Boolean))])
}

export const finalEntities = loadMerge(finalTtl, "", federationTtl)
    .sort((a, b) => a.iri.localeCompare(b.iri))
for (const entity of finalEntities) entity.sources = sourcesByIri.get(entity.iri) ?? []
