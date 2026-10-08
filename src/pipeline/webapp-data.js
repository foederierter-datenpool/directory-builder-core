// Additional browser artifacts; the complete pipeline files remain unchanged.
import fs from "node:fs"
import path from "node:path"
import { DataFactory } from "n3"
import { CDP, parseTtl, PATHS, prefixesOf } from "../utils.js"
import { buildMergeEntities, createResolutionLookup, groupMergeEntities, loadSourceMeta,
    mergeConflict, mergeViewSettings, summarizeMergeEntity } from "../merge-view.js"
import { compactIri, encodeMergeChunk, WEBAPP_DATA_VERSION, webappChunkingEnabled } from "../webapp-data.js"
import { MAPPED_GRAPH } from "./steps/map.js"
import { MATCH_GRAPH, HAS_MEMBER } from "./steps/match.js"
import { createMergeDerivations, MERGED_GRAPH } from "./steps/merge.js"

const CHUNK_SIZE = 100
const namedNode = DataFactory.namedNode

export function writeWebappData({ store, quads: config, abs }) {
    const destination = abs(PATHS.webappData)
    if (!webappChunkingEnabled(config)) {
        fs.rmSync(destination, { recursive: true, force: true })
        return
    }
    const federationTtl = fs.readFileSync(abs(PATHS.federation), "utf8")
    const prefixes = { cdp: CDP, ...prefixesOf(federationTtl) }
    const compact = iri => compactIri(iri, prefixes)
    const settings = mergeViewSettings(config)
    const sourceMeta = loadSourceMeta(federationTtl)
    const matches = store.getQuads(null, HAS_MEMBER, null, MATCH_GRAPH)
    const { members, recordsFor } = createMergeDerivations(store)
    const sourceOfRecord = new Map(store.getQuads(null, namedNode(`${CDP}fromSource`), null, MAPPED_GRAPH)
        .map(q => [q.subject.value, q.object.value]))

    const entityFor = (iri) => {
        const records = recordsFor(iri)
        return buildMergeEntities(store.getQuads(namedNode(iri), null, null, MERGED_GRAPH), {
            prefixes, sourceMeta, sourceOfRecord,
            recordsFor: (_subject, predicate, object) => [...(records.get(`${predicate}\t${object}`) ?? [])],
        })[0]
    }

    const summaries = [...members.keys()].map(iri => summarizeMergeEntity(entityFor(iri), settings))
        .sort((a, b) => b.conflictCount - a.conflictCount || a.iri.localeCompare(b.iri))
    const positionOf = new Map(summaries.map((entity, position) => [entity.iri, position]))
    const grouped = groupMergeEntities(summaries).map(row => row.e)
    const chunkOf = new Map(grouped.map((entity, position) => [entity.iri, Math.floor(position / CHUNK_SIZE)]))
    const sources = [...sourceMeta.keys()]
    const sourceIndex = new Map(sources.map((iri, position) => [iri, position]))
    const types = [...new Set(summaries.map(entity => entity.type))]
    const typeIndex = new Map(types.map((type, position) => [type, position]))
    const index = {
        version: WEBAPP_DATA_VERSION, prefixes, sources: sources.map(compact), types, chunkSize: CHUNK_SIZE,
        entities: summaries.map(entity => [compact(entity.iri), typeIndex.get(entity.type),
            entity.sources.map(iri => sourceIndex.get(iri)), entity.recordCount, entity.conflictCount,
            entity.parents.filter(iri => positionOf.has(iri)).map(iri => positionOf.get(iri)), chunkOf.get(entity.iri)]),
    }
    const curation = fs.existsSync(abs(PATHS.curation)) ? parseTtl(fs.readFileSync(abs(PATHS.curation), "utf8")) : []
    const resolutionOf = createResolutionLookup(config, matches, curation,
        parseTtl(fs.readFileSync(abs(PATHS.final), "utf8")), prefixes)

    const temporary = fs.mkdtempSync(path.join(path.dirname(destination), ".webapp-"))
    try {
        fs.chmodSync(temporary, 0o755)
        for (let start = 0; start < summaries.length; start += CHUNK_SIZE) {
            const entities = grouped.slice(start, start + CHUNK_SIZE).map(summary => {
                const entity = entityFor(summary.iri)
                for (const field of entity.fields) if (mergeConflict(field, settings.expectedMulti))
                    field.resolution = resolutionOf(entity.iri, field)
                return entity
            })
            fs.writeFileSync(path.join(temporary, path.basename(PATHS.mergeChunk(start / CHUNK_SIZE))),
                JSON.stringify(encodeMergeChunk(entities, index)))
        }
        fs.writeFileSync(path.join(temporary, "index.json"), JSON.stringify(index))
        fs.rmSync(destination, { recursive: true, force: true })
        fs.renameSync(temporary, destination)
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true })
    }
    console.log(`webapp: wrote ${summaries.length} Merge entities in ${Math.ceil(summaries.length / CHUNK_SIZE)} chunks → ${PATHS.webappData}`)
}
