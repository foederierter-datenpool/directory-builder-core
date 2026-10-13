// Match indexes retain the complete graph; chunks carry labels and member details.
import { DataFactory } from "n3"
import { localName, NAMESPACES, PATHS } from "../utils.js"
import { matchCellValue, matchCriteria, matchPages, readMatchData } from "../match-view.js"
import { compactIri, WEBAPP_DATA_VERSION } from "../webapp-data.js"
import { MAPPED_GRAPH } from "./steps/map.js"
import { MATCH_GRAPH } from "./steps/match.js"
import { MERGED_GRAPH } from "./steps/merge.js"

const CHUNK_SIZE = 80
const namedNode = DataFactory.namedNode

export function writeMatchWebappData({ store, quads, federationTtl }, { prefixes, sources, sourceOfRecord, writeJson }) {
    const compact = iri => compactIri(iri, prefixes)
    const data = readMatchData(federationTtl,
        store.getQuads(null, null, null, MATCH_GRAPH).sort((a, b) => a.subject.value.localeCompare(b.subject.value)),
        store.getQuads(null, null, null, MERGED_GRAPH).sort((a, b) => a.subject.value.localeCompare(b.subject.value)))
    const positions = new Map(data.nodes.map((node, position) => [node.id, position]))
    const visibleTypes = new Set(data.lanes.filter(lane => !lane.hidden).map(lane => lane.key))
    const pages = matchPages(data.nodes.filter(node => visibleTypes.has(node.type)), data.edges, CHUNK_SIZE)
    const visible = new Set(pages.flat())
    pages.push(...matchPages(data.nodes.filter(node => !visible.has(node.id)), data.edges, CHUNK_SIZE))
    const chunkOf = new Map(pages.flatMap((page, chunk) => page.map(iri => [iri, chunk])))
    const types = data.lanes.map(lane => lane.key)
    const sourceIndex = new Map(sources.map((source, position) => [source, position]))
    const criteria = matchCriteria(quads)
    const schemaOf = new Map(data.lanes.map(lane => [lane.key, lane.schema]))
    const quadsFor = (record, predicate) => store.getQuads(namedNode(record), namedNode(predicate), null, MAPPED_GRAPH)
    const index = {
        version: WEBAPP_DATA_VERSION, prefixes, sources: sources.map(compact), types, chunkSize: CHUNK_SIZE,
        entities: data.nodes.map(node => [compact(node.id), types.indexOf(node.type), data.members.get(node.id)?.length ?? 0, chunkOf.get(node.id)]),
        edges: data.edges.map(edge => [positions.get(edge.from), positions.get(edge.to)]),
    }
    for (const [chunk, page] of pages.entries()) {
        const rows = page.map(iri => {
            const position = positions.get(iri), node = data.nodes[position]
            const predicates = criteria.get(schemaOf.get(node.type)) ?? []
            const records = (data.members.get(iri) ?? []).map(record => [
                compact(record), sourceIndex.get(sourceOfRecord.get(record)),
                quadsFor(record, `${NAMESPACES.schema}identifier`).find(q => q.object.termType === "Literal")?.object.value ?? null,
                predicates.map(predicate => matchCellValue(quadsFor, record, predicate, prefixes) ?? null),
            ])
            return [position, node.label ?? localName(iri), records]
        })
        writeJson(PATHS.matchChunk(chunk), rows)
    }
    writeJson(PATHS.matchIndex, index)
    return { clusters: data.nodes.length, chunks: pages.length }
}
