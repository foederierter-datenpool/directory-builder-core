// Directory uses resolved card chunks when available, otherwise the full RDF.
import { loadMerge } from "./loadMerge.js"
import { displayPrefixes, federationTtl, fetchTexts } from "./instanceData.js"
import { parseTtl, PATHS } from "@directory-builder/core/utils"
import { createChunkLoader, decodeDirectoryIndex, decodeEntityChunk, directoryComparator } from "@directory-builder/core/webapp-data"
import { fetchChunk, loadWebappIndex } from "./webappData.js"

const index = await loadWebappIndex()
let entities
if (index?.directory) {
    entities = decodeDirectoryIndex(index)
} else {
    const [finalTtl, indexText] = await fetchTexts([PATHS.final, PATHS.entitySources])
    const sourcesByIri = indexText ? new Map(Object.entries(JSON.parse(indexText))) : new Map()
    if (!indexText) {
        const [mergedTtl, provTtl] = await fetchTexts([PATHS.merged, PATHS.provenance])
        for (const entity of loadMerge(mergedTtl, provTtl, federationTtl))
            sourcesByIri.set(entity.iri, [...new Set(entity.columns.map(c => c.source).filter(Boolean))])
    }
    entities = loadMerge(finalTtl, "", federationTtl)
    for (const entity of entities) entity.sources = sourcesByIri.get(entity.iri) ?? []
}
entities.sort(directoryComparator(parseTtl(federationTtl), displayPrefixes))

export const finalEntities = entities
export const directoryPageSize = index?.directory ? index.chunkSize : 100
export const loadDirectoryPage = index?.directory ? createChunkLoader(async number =>
    decodeEntityChunk(await fetchChunk(PATHS.directoryChunk(number)), index)) : async summaries => summaries
