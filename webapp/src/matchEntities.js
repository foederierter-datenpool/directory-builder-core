// Match opens compact metadata first and loads member details for visible clusters.
import { DataFactory, Store } from "n3"
import { CDP, NAMESPACES, parseTtl, PATHS } from "@directory-builder/core/utils"
import { matchCellValue, matchCriteria, readMatchData, readSchemas } from "@directory-builder/core/match-view"
import { createChunkLoader, decodeMatchChunk, decodeMatchIndex } from "@directory-builder/core/webapp-data"
import { displayPrefixes, federationTtl, fetchText, fetchTexts } from "./instanceData.js"
import { fetchChunk, loadWebappIndex } from "./webappData.js"

export const allLanes = readSchemas(federationTtl).lanes
export const criteriaByTarget = matchCriteria(parseTtl(federationTtl))
const index = await loadWebappIndex(PATHS.matchIndex)
let data, loadPage
if (index) {
    data = { ...decodeMatchIndex(index), lanes: allLanes, members: new Map() }
    loadPage = createChunkLoader(async number => decodeMatchChunk(await fetchChunk(PATHS.matchChunk(number)), index))
} else {
    const [mappedTtl, matchesTtl, mergedTtl] = await fetchTexts([PATHS.mapped, PATHS.matches, PATHS.merged])
    data = readMatchData(federationTtl, parseTtl(matchesTtl), parseTtl(mergedTtl))
    const mapped = new Store(parseTtl(mappedTtl))
    const namedNode = DataFactory.namedNode
    const quadsFor = (record, predicate) => mapped.getQuads(namedNode(record), namedNode(predicate), null, null)
    const schemaOf = new Map(allLanes.map(lane => [lane.key, lane.schema]))
    loadPage = async nodes => nodes.map(node => ({
        iri: node.id, type: node.type, label: node.label,
        records: (data.members.get(node.id) ?? []).map(iri => ({
            iri, source: quadsFor(iri, `${CDP}fromSource`)[0]?.object.value,
            identifier: quadsFor(iri, `${NAMESPACES.schema}identifier`).find(q => q.object.termType === "Literal")?.object.value,
            values: (criteriaByTarget.get(schemaOf.get(node.type)) ?? [])
                .map(predicate => matchCellValue(quadsFor, iri, predicate, displayPrefixes)),
        })),
    }))
}

const curation = parseTtl(await fetchText(PATHS.curation))
export const manualPairs = curation.filter(q => q.predicate.value === `${NAMESPACES.owl}sameAs`).map(q => [q.subject.value, q.object.value])
export const distinctPairs = curation.filter(q => q.predicate.value === `${NAMESPACES.owl}differentFrom`).map(q => [q.subject.value, q.object.value])
export const matchData = data
export const matchPageSize = index?.chunkSize ?? 80
export const loadMatchPage = loadPage
