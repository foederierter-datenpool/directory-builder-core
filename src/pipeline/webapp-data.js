// Additional browser artifacts; the complete pipeline files remain unchanged.
import fs from "node:fs"
import path from "node:path"
import { DataFactory, Store } from "n3"
import { CDP, NAMESPACES, parseTtl, PATHS, prefixesOf, shrink } from "../utils.js"
import { buildMergeEntities, createResolutionLookup, groupMergeEntities, loadSourceMeta,
    mergeConflict, mergeViewSettings, summarizeMergeEntity } from "../merge-view.js"
import { compactIri, directoryComparator, encodeEntityChunk, WEBAPP_DATA_VERSION, webappChunkingEnabled } from "../webapp-data.js"
import { MAPPED_GRAPH } from "./steps/map.js"
import { MATCH_GRAPH, HAS_MEMBER } from "./steps/match.js"
import { createMergeDerivations, MERGED_GRAPH } from "./steps/merge.js"
import { writeMatchWebappData } from "./match-webapp-data.js"

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
    const finalQuads = parseTtl(fs.readFileSync(abs(PATHS.final), "utf8"))
    const finalStore = new Store(finalQuads)
    const finalEntities = [...new Set(finalQuads.map(quad => quad.subject.value))].map(iri => ({
        iri, type: shrink(finalStore.getQuads(namedNode(iri), namedNode(`${NAMESPACES.rdf}type`), null, null).at(-1)?.object.value ?? "", prefixes),
    })).sort(directoryComparator(config, prefixes))
    const finalIris = finalEntities.map(entity => entity.iri)
    const finalEntityFor = iri => buildMergeEntities(finalStore.getQuads(namedNode(iri), null, null, null), {
        prefixes, sourceMeta, sourceOfRecord, recordsFor: () => [],
    })[0]
    const types = [...new Set(summaries.map(entity => entity.type))]
    const typeIndex = new Map(types.map((type, position) => [type, position]))
    const directory = finalEntities.map(({ iri, type }) => {
        if (!typeIndex.has(type)) { typeIndex.set(type, types.length); types.push(type) }
        if (!positionOf.has(iri)) {
            positionOf.set(iri, summaries.length)
            summaries.push({ iri, type, sources: [], recordCount: 0, conflictCount: 0, parents: [] })
        }
        return [positionOf.get(iri), typeIndex.get(type)]
    })
    const index = {
        version: WEBAPP_DATA_VERSION, prefixes, sources: sources.map(compact), types, chunkSize: CHUNK_SIZE, directory,
        entities: summaries.map(entity => [compact(entity.iri), typeIndex.get(entity.type),
            entity.sources.map(iri => sourceIndex.get(iri)), entity.recordCount, entity.conflictCount,
            entity.parents.filter(iri => positionOf.has(iri)).map(iri => positionOf.get(iri)), chunkOf.get(entity.iri)]),
    }
    const curation = fs.existsSync(abs(PATHS.curation)) ? parseTtl(fs.readFileSync(abs(PATHS.curation), "utf8")) : []
    const resolutionOf = createResolutionLookup(config, matches, curation, finalQuads, prefixes)

    const temporary = fs.mkdtempSync(path.join(path.dirname(destination), ".webapp-"))
    try {
        fs.chmodSync(temporary, 0o755)
        const writeJson = (file, data) => fs.writeFileSync(path.join(temporary, path.basename(file)), JSON.stringify(data))
        for (let start = 0; start < grouped.length; start += CHUNK_SIZE) {
            const entities = grouped.slice(start, start + CHUNK_SIZE).map(summary => {
                const entity = entityFor(summary.iri)
                for (const field of entity.fields) if (mergeConflict(field, settings.expectedMulti))
                    field.resolution = resolutionOf(entity.iri, field)
                return entity
            })
            writeJson(PATHS.mergeChunk(start / CHUNK_SIZE), encodeEntityChunk(entities, index))
        }
        for (let start = 0; start < finalIris.length; start += CHUNK_SIZE)
            writeJson(PATHS.directoryChunk(start / CHUNK_SIZE),
                encodeEntityChunk(finalIris.slice(start, start + CHUNK_SIZE).map(finalEntityFor), index))
        const match = writeMatchWebappData({ store, quads: config, federationTtl }, { prefixes, sources, sourceOfRecord, writeJson })
        writeJson(PATHS.webappIndex, index)
        fs.rmSync(destination, { recursive: true, force: true })
        fs.renameSync(temporary, destination)
        console.log(`webapp: wrote ${grouped.length} Merge cards, ${finalIris.length} Directory cards and ${match.clusters} Match clusters → ${PATHS.webappData}`)
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true })
    }
}
