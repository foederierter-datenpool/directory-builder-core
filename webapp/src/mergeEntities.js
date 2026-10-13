// Merge uses generated metadata when enabled, with full RDF loading otherwise.
import { loadMerge } from "./loadMerge.js"
import { federationTtl, fetchTexts } from "./instanceData.js"
import { parseTtl, PATHS } from "@directory-builder/core/utils"
import { mergeViewSettings, summarizeMergeEntity } from "@directory-builder/core/merge-view"
import { createChunkLoader, decodeEntityChunk, decodeMergeIndex } from "@directory-builder/core/webapp-data"
import { fetchChunk, loadWebappIndex } from "./webappData.js"

const config = parseTtl(federationTtl)
const index = await loadWebappIndex()

let entities, lookupResolution
if (index) {
    entities = decodeMergeIndex(index).filter(entity => entity.chunk != null)
    lookupResolution = (_iri, field) => field.resolution ?? { finals: [], corrections: [], strategyDecides: false }
} else {
    const resolution = import("./resolvePlan.js")
    const [mergedTtl, provTtl] = await fetchTexts([PATHS.merged, PATHS.provenance])
    const settings = mergeViewSettings(config)
    entities = loadMerge(mergedTtl, provTtl, federationTtl)
    for (const entity of entities) Object.assign(entity, summarizeMergeEntity(entity, settings))
    entities.sort((a, b) => b.conflictCount - a.conflictCount || a.iri.localeCompare(b.iri))
    lookupResolution = (await resolution).resolutionOf
}

export const mergeEntities = entities
export const mergePageSize = index?.chunkSize ?? 100
export const resolutionOf = lookupResolution
export const loadMergePage = index ? createChunkLoader(async number =>
    decodeEntityChunk(await fetchChunk(PATHS.mergeChunk(number)), index)) : async summaries => summaries
