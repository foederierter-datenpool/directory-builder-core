// Merge uses generated metadata when enabled, with full RDF loading otherwise.
import { loadMerge } from "./loadMerge.js"
import { federationTtl, fetchTexts, fetchText } from "./instanceData.js"
import { parseTtl, PATHS } from "@directory-builder/core/utils"
import { mergeViewSettings, summarizeMergeEntity } from "@directory-builder/core/merge-view"
import { createMergeChunkLoader, decodeMergeChunk, decodeMergeIndex, WEBAPP_DATA_VERSION,
    webappChunkingEnabled } from "@directory-builder/core/webapp-data"

const config = parseTtl(federationTtl)
let index
if (webappChunkingEnabled(config)) {
    try {
        const candidate = JSON.parse(await fetchText(PATHS.webappIndex))
        if (candidate.version === WEBAPP_DATA_VERSION) index = candidate
    } catch { /* Snapshots without a compatible index use the complete RDF files. */ }
}

let entities, lookupResolution
if (index) {
    entities = decodeMergeIndex(index)
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
export const loadMergePage = index ? createMergeChunkLoader(async number => {
    const response = await fetch(`${import.meta.env.BASE_URL}${PATHS.mergeChunk(number)}`)
    if (!response.ok) throw new Error(`Could not load Merge page (${response.status})`)
    return decodeMergeChunk(await response.json(), index)
}) : async summaries => summaries
