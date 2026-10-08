// Compact browser indexes, detail chunks and request caching.
import { CDP, shrink } from "./utils.js"

export const WEBAPP_DATA_VERSION = 2

export const webappChunkingEnabled = (quads) => quads.some(q =>
    q.subject.value === `${CDP}federation` && q.predicate.value === `${CDP}webappChunking`
    && ["true", "1"].includes(q.object.value))

export const compactIri = (iri, prefixes) => {
    const short = shrink(iri, prefixes)
    return short === iri ? `<${iri}>` : short
}

const expandIri = (iri, prefixes) => {
    if (iri.startsWith("<")) return iri.slice(1, -1)
    const colon = iri.indexOf(":")
    const namespace = prefixes[iri.slice(0, colon)]
    return namespace ? namespace + iri.slice(colon + 1) : iri
}

// Index rows: IRI, type, sources, record count, conflict count, parents, chunk.
export function decodeMergeIndex(index) {
    const expand = iri => expandIri(iri, index.prefixes)
    const iris = index.entities.map(row => expand(row[0]))
    const sources = index.sources.map(expand)
    return index.entities.map((row, position) => ({
        iri: iris[position], type: index.types[row[1]], sources: row[2].map(source => sources[source]),
        recordCount: row[3], conflictCount: row[4], parents: row[5].map(parent => iris[parent]),
        chunk: row[6],
    }))
}

// Card rows: IRI, type, columns, fields. Values reference their record columns;
// a one-item array marks an abbreviated IRI, while strings remain literal text.
export function encodeMergeChunk(entities, index) {
    const compact = iri => compactIri(iri, index.prefixes)
    const sources = new Map(index.sources.map((source, position) => [expandIri(source, index.prefixes), position]))
    const types = new Map(index.types.map((type, position) => [type, position]))
    return entities.map(entity => {
        const columnOf = new Map(entity.columns.map((column, position) => [column.record, position]))
        return [compact(entity.iri), types.get(entity.type),
            entity.columns.map(column => [compact(column.record), sources.get(column.source)]),
            entity.fields.map(field => {
                const row = [compact(field.predicate), field.values.map(value => [
                    value.value === value.raw ? value.raw : [compact(value.raw)],
                    value.records.map(record => columnOf.get(record)),
                ])]
                if (field.resolution) {
                    const { strategy, finals, corrections, strategyDecides } = field.resolution
                    row.push([strategy, finals, corrections.map(correction => [
                        correction.entity ? compact(correction.entity) : null,
                        compact(correction.on), correction.wrong, correction.right,
                    ]), strategyDecides])
                }
                return row
            })]
    })
}

export function decodeMergeChunk(rows, index) {
    const expand = iri => expandIri(iri, index.prefixes)
    const display = iri => shrink(iri, index.prefixes)
    const sources = index.sources.map(expand)
    return rows.map(([shortIri, type, columnRows, fieldRows]) => {
        const iri = expand(shortIri)
        const columns = columnRows.map(([record, source]) => ({ record: expand(record), source: sources[source] }))
        const fields = fieldRows.map(([shortPredicate, valueRows, resolution]) => {
            const predicate = expand(shortPredicate)
            const values = valueRows.map(([encoded, positions]) => {
                const raw = Array.isArray(encoded) ? expand(encoded[0]) : encoded
                return {
                    value: Array.isArray(encoded) ? display(raw) : raw, raw,
                    sources: [...new Set(positions.map(position => columns[position].source))],
                    records: positions.map(position => columns[position].record),
                }
            })
            const field = { predicate, predLabel: display(predicate), values }
            if (resolution) {
                const [strategy, finals, corrections, strategyDecides] = resolution
                field.resolution = {
                    strategy, finals, corrections: corrections.map(([entity, on, wrong, right]) => ({
                        entity: entity ? expand(entity) : undefined, on: expand(on), wrong, right,
                    })), strategyDecides,
                }
            }
            return field
        })
        return { iri, label: display(iri), type: index.types[type], columns, fields }
    })
}

export function createMergeChunkLoader(readChunk) {
    const pending = new Map()
    const load = (chunk) => {
        if (!pending.has(chunk)) pending.set(chunk, Promise.resolve().then(() => readChunk(chunk))
            .then(entities => new Map(entities.map(entity => [entity.iri, entity])))
            .catch(error => { pending.delete(chunk); throw error }))
        return pending.get(chunk)
    }
    return async (summaries) => {
        const chunks = [...new Set(summaries.map(entity => entity.chunk))]
        const loaded = new Map(await Promise.all(chunks.map(async chunk => [chunk, await load(chunk)])))
        return summaries.map(summary => {
            const entity = loaded.get(summary.chunk).get(summary.iri)
            if (!entity) throw new Error(`Merge chunk is missing ${summary.iri}`)
            return entity
        })
    }
}
