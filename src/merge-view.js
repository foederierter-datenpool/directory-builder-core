// Browser-safe Merge cards, source metadata and resolution explanations.
import { CDP, NAMESPACES, parseTtl, shrink } from "./utils.js"

const RDF_TYPE = `${NAMESPACES.rdf}type`
const RDFS_LABEL = `${NAMESPACES.rdfs}label`
const SKOS_NOTATION = `${NAMESPACES.skos}notation`
const HAS_SOURCE = `${CDP}hasSource`

// Source identities, labels and short codes come from federation.ttl.
// Order follows :hasSource; contributing records link via cdp:fromSource.
export function loadSourceMeta(federationTtl) {
    const order = new Map()
    const labelOf = new Map()
    const notationOf = new Map()
    let n = 0
    for (const q of parseTtl(federationTtl)) {
        const p = q.predicate.value
        if      (p === HAS_SOURCE && !order.has(q.object.value)) order.set(q.object.value, n++)
        else if (p === RDFS_LABEL)    labelOf.set(q.subject.value, q.object.value)
        else if (p === SKOS_NOTATION) notationOf.set(q.subject.value, q.object.value)
    }
    const meta = new Map()
    for (const iri of order.keys()) {
        meta.set(iri, { iri, label: labelOf.get(iri), notation: notationOf.get(iri), order: order.get(iri) })
    }
    return meta
}

// Order two Source IRIs by their federation declaration order, then IRI.
export function compareSources(a, b, meta) {
    const oa = meta.get(a).order
    const ob = meta.get(b).order
    return oa !== ob ? oa - ob : a.localeCompare(b)
}

// Builds cards from parsed quads and per-value contributing records.
export function buildMergeEntities(mergedQuads, { prefixes, sourceMeta, sourceOfRecord, recordsFor }) {
    // Display IRIs use the federation's declared prefixes.
    const prefixedIri = (iri) => shrink(iri, prefixes)
    const toSources = (records) => [...new Set(records.map(r => sourceOfRecord.get(r)))]

    // Preserve input quad order when building cards and their fields.
    const entities = []
    const entityIndex = new Map()
    const fieldIndexByEntity = new Map()
    for (const q of mergedQuads) {
        const entityIri = q.subject.value
        const predIri = q.predicate.value
        const value = q.object.value

        if (!entityIndex.has(entityIri)) {
            entityIndex.set(entityIri, entities.length)
            fieldIndexByEntity.set(entityIri, new Map())
            entities.push({ iri: entityIri, label: prefixedIri(entityIri), fields: [] })
        }
        const entity = entities[entityIndex.get(entityIri)]
        const fieldIndex = fieldIndexByEntity.get(entityIri)

        // The class appears in the card header rather than a field row.
        if (predIri === RDF_TYPE) { entity.type = prefixedIri(value); continue }

        if (!fieldIndex.has(predIri)) {
            fieldIndex.set(predIri, entity.fields.length)
            entity.fields.push({ predicate: predIri, predLabel: prefixedIri(predIri), values: [] })
        }
        const field = entity.fields[fieldIndex.get(predIri)]
        const records = recordsFor(entityIri, predIri, value)
        const sources = toSources(records)
        const displayValue = q.object.termType === "NamedNode" ? prefixedIri(value) : value
        field.values.push({ value: displayValue, raw: value, sources, records })
    }

    // Values with more supporting sources come first. Records from the same
    // source keep separate columns, ordered by source then record IRI.
    for (const entity of entities) {
        for (const f of entity.fields) f.values.sort((a, b) => b.sources.length - a.sources.length)
        const all = new Set()
        for (const f of entity.fields) for (const v of f.values) for (const r of v.records) all.add(r)
        entity.columns = [...all].map((r) => ({ record: r, source: sourceOfRecord.get(r) }))
            .sort((a, b) => compareSources(a.source, b.source, sourceMeta) || a.record.localeCompare(b.record))
    }
    return entities
}

export function createResolutionLookup(fedQuads, matchesQuads, curationQuads, finalQuads, displayPrefixes) {
    const RDF_TYPE = `${NAMESPACES.rdf}type`
    const local = (iri) => iri.split("#").pop()
    const objOf = (quads, subj, pred) => quads.find((q) => q.subject.value === subj && q.predicate.value === `${CDP}${pred}`)?.object.value

    // Per-predicate overrides take precedence over :defaultStrategy;
    // without either, the engine uses longestValue.
    const defaultStrategy = fedQuads.find((q) => q.predicate.value === `${CDP}defaultStrategy`)?.object.value ?? `${CDP}longestValue`
    const overrides = new Map(fedQuads.filter((q) => q.predicate.value === `${CDP}hasOverride`)
        .map((q) => [objOf(fedQuads, q.object.value, "on"), objOf(fedQuads, q.object.value, "strategy")]))

    // Corrections may name a source record; match membership identifies its cluster.
    const mintedOf = new Map(matchesQuads.filter((q) => q.predicate.value === `${CDP}hasMember`)
        .map((q) => [q.object.value, q.subject.value]))

    const CORRECTIONS = curationQuads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === `${CDP}ValueCorrection`)
        .map((q) => {
            const entity = objOf(curationQuads, q.subject.value, "entity")
            return {
                entity: entity && (mintedOf.get(entity) ?? entity),
                on: objOf(curationQuads, q.subject.value, "on"),
                wrong: objOf(curationQuads, q.subject.value, "wrong"),
                right: objOf(curationQuads, q.subject.value, "right"),
            }
        })

    const finalIndex = new Map()
    for (const q of finalQuads) {
        if (q.predicate.value === RDF_TYPE) continue
        const k = `${q.subject.value}\t${q.predicate.value}`
        if (!finalIndex.has(k)) finalIndex.set(k, [])
        finalIndex.get(k).push(q.object.termType === "NamedNode" ? shrink(q.object.value, displayPrefixes) : q.object.value)
    }

    return (entityIri, field) => {
        const corrections = CORRECTIONS.filter((c) => c.on === field.predicate
            && (!c.entity || c.entity === entityIri)
            && field.values.some((v) => v.raw === c.wrong))
        // Corrections rewrite candidates before the strategy. Only remaining
        // disagreement needs a strategy, so the tooltip credits the right step.
        const afterCuration = new Set(field.values.map((v) => corrections.find((c) => c.wrong === v.raw)?.right ?? v.raw))
        return {
            strategy: local(overrides.get(field.predicate) ?? defaultStrategy),
            finals: finalIndex.get(`${entityIri}\t${field.predicate}`) ?? [],
            corrections,
            strategyDecides: afterCuration.size > 1,
        }
    }
}

export function mergeViewSettings(quads) {
    const objects = (predicate) => new Map(quads.filter(q => q.predicate.value === `${CDP}${predicate}`)
        .map(q => [q.subject.value, q.object.value]))
    const targetClass = objects("targetClass"), targetSchema = objects("toTargetSchema")
    const fieldPredicate = objects("targetPredicate")
    const multiFields = new Set(quads.filter(q => q.predicate.value === `${CDP}multiValued`
        && ["true", "1"].includes(q.object.value)).map(q => q.subject.value))
    return {
        expectedMulti: new Set([`${CDP}fromSource`, ...[...multiFields].map(field => fieldPredicate.get(field))]),
        hierarchyPredicates: new Set(quads.filter(q => q.predicate.value === `${CDP}toTargetField`
            && targetClass.get(targetSchema.get(q.subject.value)) !== `${NAMESPACES.schema}PostalAddress`)
            .map(q => fieldPredicate.get(q.object.value)).filter(Boolean)),
    }
}

export const mergeConflict = (field, expectedMulti) => !expectedMulti.has(field.predicate) && field.values.length > 1

export function summarizeMergeEntity(entity, { expectedMulti, hierarchyPredicates }) {
    return {
        iri: entity.iri, type: entity.type,
        sources: [...new Set(entity.columns.map(c => c.source).filter(Boolean))],
        recordCount: entity.columns.length,
        conflictCount: entity.fields.filter(f => mergeConflict(f, expectedMulti)).length,
        parents: entity.fields.filter(f => hierarchyPredicates.has(f.predicate))
            .map(f => f.values[0]?.raw).filter(iri => iri && iri !== entity.iri),
    }
}

export function mergeStatistics(entities) {
    let multiRecord = 0, withConflicts = 0, records = 0
    const sources = new Set(), byTier = new Map()
    for (const entity of entities) {
        records += entity.recordCount
        entity.sources.forEach(source => sources.add(source))
        const multiple = entity.recordCount > 1, conflict = entity.conflictCount > 0
        if (multiple) multiRecord++
        if (conflict) withConflicts++
        const tier = byTier.get(entity.type) ?? { total: 0, multiRecord: 0, conflicts: 0 }
        tier.total++; if (multiple) tier.multiRecord++; if (conflict) tier.conflicts++
        byTier.set(entity.type, tier)
    }
    return { total: entities.length, multiRecord, withConflicts, records, sources: sources.size, byTier }
}

// Filtered-out parents leave their children at the root; cycles are visited once.
export function groupMergeEntities(entities) {
    const visible = new Set(entities.map(entity => entity.iri))
    const children = new Map(), hasParent = new Set()
    for (const entity of entities) {
        const parent = entity.parents.find(iri => visible.has(iri))
        if (!parent) continue
        if (!children.has(parent)) children.set(parent, [])
        children.get(parent).push(entity)
        hasParent.add(entity.iri)
    }
    const rows = [], seen = new Set()
    const visit = (entity, depth) => {
        if (seen.has(entity.iri)) return
        seen.add(entity.iri)
        rows.push({ e: entity, depth })
        for (const child of children.get(entity.iri) ?? []) visit(child, depth + 1)
    }
    entities.filter(entity => !hasParent.has(entity.iri)).forEach(entity => visit(entity, 0))
    entities.forEach(entity => visit(entity, 0))
    return rows
}
