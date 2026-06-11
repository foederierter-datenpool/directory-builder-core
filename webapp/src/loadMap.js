// Helpers for the Map view: build the schema-mapping graph and resolve per-entity
// source/target field values. Pure (ttl in → data out).
// Reads:  TTL strings passed by MapGraph.jsx (federation, mapped, cleaned source TTL)
// Does:   returns { nodes, edges } plus per-source / per-entity value maps

import { CDP as NS, localName, parseTtl, prefixesOf, shrink, sourceName, subjectsOfType, typesOf } from "@directory-builder/core/utils"

const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
const NODE_TYPES = [`${NS}Source`, `${NS}SourceField`, `${NS}TargetField`, `${NS}TargetSchema`]
const SUB_FIELD = `${NS}SubField`

// Group entities by source. Each entity carries a cdp:fromSource triple in mapped.ttl
// pointing at its Source IRI, so this is a single-pass scan with no prefix
// matching.
export function loadEntitiesBySource(_federationTtl, mappedTtl) {
    const SCHEMA_NAME       = "http://schema.org/name"
    const SCHEMA_IDENTIFIER = "http://schema.org/identifier"
    const FROM_SOURCE       = `${NS}fromSource`

    const entitySource = new Map()  // entityIri -> sourceIri
    const ids       = new Map()
    const names     = new Map()
    for (const q of parseTtl(mappedTtl)) {
        const p = q.predicate.value
        if      (p === FROM_SOURCE)       entitySource.set(q.subject.value, q.object.value)
        else if (p === SCHEMA_IDENTIFIER) ids.set(q.subject.value, q.object.value)
        else if (p === SCHEMA_NAME)       names.set(q.subject.value, q.object.value)
    }

    const result = new Map()
    for (const [iri, src] of entitySource) {
        if (!result.has(src)) result.set(src, [])
        result.get(src).push({
            iri,
            id:   ids.get(iri) ?? localName(iri),
            name: names.get(iri) ?? "",
        })
    }
    for (const list of result.values()) list.sort((a, b) => a.id.localeCompare(b.id))
    return result
}

// For each entity in mapped.ttl, resolve the literal value of each of its
// source fields/sub-fields (from the source's lifted/cleaned TTL) AND each
// target field (from mapped.ttl, indirected via the field's :targetPredicate).
// Returns Map<entityIri, Map<fieldIri, string>>.
export function loadFieldValuesByEntity(federationTtl, mappedTtl, liftedBySource) {
    const fedQuads = parseTtl(federationTtl)
    const fieldPathOf       = new Map()
    const fieldsBySource    = new Map()
    const subFieldsOf       = new Map()
    const targetPredicateOf = new Map()
    const entitiesOf        = new Map()
    for (const q of fedQuads) {
        const p = q.predicate.value
        if      (p === `${NS}fieldPath`)        fieldPathOf.set(q.subject.value, q.object.value)
        else if (p === `${NS}targetPredicate`)  targetPredicateOf.set(q.subject.value, q.object.value)
        else if (p === `${NS}hasField`) {
            if (!fieldsBySource.has(q.subject.value)) fieldsBySource.set(q.subject.value, [])
            fieldsBySource.get(q.subject.value).push(q.object.value)
        } else if (p === `${NS}hasSubField`) {
            if (!subFieldsOf.has(q.subject.value)) subFieldsOf.set(q.subject.value, [])
            subFieldsOf.get(q.subject.value).push(q.object.value)
        } else if (p === `${NS}hasEntity`) {
            if (!entitiesOf.has(q.subject.value)) entitiesOf.set(q.subject.value, [])
            entitiesOf.get(q.subject.value).push(q.object.value)
        }
    }
    // Entity-grouped sources: fold each :SourceEntity's fields into its source's list.
    for (const [src, ents] of entitiesOf) {
        if (!fieldsBySource.has(src)) fieldsBySource.set(src, [])
        for (const e of ents) fieldsBySource.get(src).push(...(fieldsBySource.get(e) ?? []))
    }

    const FROM_SOURCE = `${NS}fromSource`
    const entitySource     = new Map() // entityIri -> sourceIri
    const literalsByEntity = new Map() // entityIri -> Map<predicateIri, string>
    for (const q of parseTtl(mappedTtl)) {
        if (q.predicate.value === FROM_SOURCE) entitySource.set(q.subject.value, q.object.value)
        if (q.object.termType === "Literal") {
            if (!literalsByEntity.has(q.subject.value)) literalsByEntity.set(q.subject.value, new Map())
            literalsByEntity.get(q.subject.value).set(q.predicate.value, q.object.value)
        }
    }

    const result = new Map()
    for (const [sourceIri, liftedTtl] of liftedBySource) {
        // subject -> Map<predicate-localname, [{value, isLiteral}]>
        const graph = new Map()
        for (const q of parseTtl(liftedTtl)) {
            const sub = q.subject.value
            const predLocal = localName(q.predicate.value)
            if (!graph.has(sub)) graph.set(sub, new Map())
            const preds = graph.get(sub)
            if (!preds.has(predLocal)) preds.set(predLocal, [])
            preds.get(predLocal).push({ value: q.object.value, isLiteral: q.object.termType === "Literal" })
        }

        const fields = fieldsBySource.get(sourceIri) ?? []
        for (const [entityIri, src] of entitySource) {
            if (src !== sourceIri) continue
            // Source subject IS the federation IRI post-clean — no lookup needed.
            const subjectPreds = graph.get(entityIri)
            if (!subjectPreds) continue

            const valueMap = new Map()
            for (const fieldIri of fields) {
                const fp = fieldPathOf.get(fieldIri)
                if (!fp) continue
                const vs = subjectPreds.get(fp)
                if (!vs?.length) continue
                const v = vs[0]
                if (v.isLiteral && v.value) valueMap.set(fieldIri, v.value)
                // Sub-fields hang off the parent field's blank-node value.
                if (subFieldsOf.has(fieldIri) && !v.isLiteral) {
                    const childPreds = graph.get(v.value)
                    if (childPreds) {
                        for (const subIri of subFieldsOf.get(fieldIri)) {
                            const subFp = fieldPathOf.get(subIri)
                            if (!subFp) continue
                            const subVs = childPreds.get(subFp)
                            if (subVs?.length && subVs[0].isLiteral && subVs[0].value) valueMap.set(subIri, subVs[0].value)
                        }
                    }
                }
            }
            result.set(entityIri, valueMap)
        }
    }

    // Layer in target-field values: indirect each :targetPredicate through the
    // entity's literal predicate->value map from mapped.ttl. These are the values
    // that flow OUT of transform nodes (and equal the source value for direct
    // 1:1 mappings).
    for (const [entityIri, preds] of literalsByEntity) {
        if (!result.has(entityIri)) result.set(entityIri, new Map())
        const valueMap = result.get(entityIri)
        for (const [tfIri, predIri] of targetPredicateOf) {
            const v = preds.get(predIri)
            if (v) valueMap.set(tfIri, v)
        }
    }
    return result
}

export function loadSources(ttl) {
    const quads = parseTtl(ttl)
    const sourceIris = subjectsOfType(quads, `${NS}Source`)
    const labelOf = new Map()
    for (const q of quads) if (q.predicate.value === RDFS_LABEL) labelOf.set(q.subject.value, q.object.value)
    return [...sourceIris].map((iri) => ({ iri, label: labelOf.get(iri) ?? localName(iri) }))
}

export function loadMap(ttl, { hideUnmappedFields = true, hideUnmappedTargetFields = true, hiddenSources } = {}) {
    // Render target-predicate IRIs like `schema:identifier` (instead of the
    // local TargetField name) using the federation's own @prefix declarations.
    const prefixes = { cdp: NS, ...prefixesOf(ttl) }
    const prefixedIri = (iri) => shrink(iri, prefixes)
    const quads = parseTtl(ttl)

    const typeOf = typesOf(quads)

    const nodeSet = new Set()
    for (const [iri, types] of typeOf) {
        if (NODE_TYPES.some((t) => types.has(t)) || types.has(SUB_FIELD)) nodeSet.add(iri)
    }

    const edges = []
    const push = (from, to, label, extra) => {
        if (nodeSet.has(from) && nodeSet.has(to)) edges.push({ from, to, label, ...extra })
    }

    // :from and :to on a field-mapping blank node can each carry multiple
    // values (comma-list in turtle), so track them as arrays. :via is
    // single-valued — it names a transform of the mapping's source
    // (sources/<source>/transform-<via>.sparql), rendered as its own node.
    const bnodeFrom = new Map()
    const bnodeTo   = new Map()
    const bnodeVia  = new Map()
    const fromSourceOf = new Map()
    const toTargetOf   = new Map()
    const schemaFields = []  // (schema, field) pairs in declaration order
    const appendTo = (map, key, val) => {
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(val)
    }
    const targetPredicate = new Map()
    const fieldPath = new Map()
    const labelOf = new Map()
    const sourceOfEntity = new Map()  // :SourceEntity iri -> its :Source iri
    const fieldPairs = []             // (owner, field) — owner is a Source or SourceEntity
    const subPairs   = []
    for (const q of quads) {
        if (q.predicate.value === `${NS}hasField`)         fieldPairs.push([q.subject.value, q.object.value])
        else if (q.predicate.value === `${NS}hasSubField`) subPairs.push([q.subject.value, q.object.value])
        else if (q.predicate.value === `${NS}hasEntity`)   sourceOfEntity.set(q.object.value, q.subject.value)
        else if (q.predicate.value === `${NS}hasTargetField`) schemaFields.push([q.subject.value, q.object.value])
        else if (q.predicate.value === `${NS}from`) appendTo(bnodeFrom, q.subject.value, q.object.value)
        else if (q.predicate.value === `${NS}to`)   appendTo(bnodeTo,   q.subject.value, q.object.value)
        else if (q.predicate.value === `${NS}via`)  bnodeVia.set(q.subject.value, q.object.value)
        else if (q.predicate.value === `${NS}fromSource`) fromSourceOf.set(q.subject.value, q.object.value)
        else if (q.predicate.value === `${NS}toTarget`)   toTargetOf.set(q.subject.value, q.object.value)
        else if (q.predicate.value === `${NS}targetPredicate`) targetPredicate.set(q.subject.value, q.object.value)
        else if (q.predicate.value === `${NS}fieldPath`) fieldPath.set(q.subject.value, q.object.value)
        else if (q.predicate.value === RDFS_LABEL) labelOf.set(q.subject.value, q.object.value)
    }

    // A field owned by a :SourceEntity gets its edge from the entity's source —
    // the entity renders not as a node but as a group rectangle around its
    // fields (sub-fields included), labelled with the entity's rdfs:label.
    const groupOf = new Map()  // field iri -> entity iri
    for (const [owner, field] of fieldPairs) {
        const src = sourceOfEntity.get(owner)
        push(src ?? owner, field, "hasField")
        if (src) groupOf.set(field, owner)
    }
    for (const [parent, sub] of subPairs) {
        push(parent, sub, "hasSubField")
        if (groupOf.has(parent)) groupOf.set(sub, groupOf.get(parent))
    }

    // Target fields are shared between schemas (one :TargetField per predicate),
    // but a single shared node draws false paths — a source feeding only one
    // schema would appear connected to every schema using the field. So render
    // one copy per (field, schema) pair and route each mapping's edges to the
    // copy of its :toTarget.
    const copyInfo = new Map()  // copy id -> { field, schema }
    const copiesOf = new Map()  // field iri -> [copy ids]
    for (const [schema, field] of schemaFields) {
        if (!nodeSet.has(field) || !nodeSet.has(schema)) continue
        const copy = `${field}|${schema}`
        copyInfo.set(copy, { field, schema })
        appendTo(copiesOf, field, copy)
        nodeSet.add(copy)
        push(copy, schema, "isTargetFieldOf")
    }
    for (const field of copiesOf.keys()) nodeSet.delete(field)
    // Deduplicate routed edges: the same (source, via) or (via, target) pair
    // can appear across multiple field-mappings sharing one transform node.
    const seen = new Set()
    const pushOnce = (f, t, label, extra) => {
        const k = `${f}|${label}|${t}`
        if (seen.has(k)) return
        seen.add(k)
        push(f, t, label, extra)
    }
    const transformLabel = new Map()  // minted node id -> "source/via" label
    for (const q of quads) {
        if (q.predicate.value === `${NS}hasFieldMapping`) {
            const froms = bnodeFrom.get(q.object.value) ?? []
            const tos   = bnodeTo.get(q.object.value)   ?? []
            const viaName = bnodeVia.get(q.object.value)
            // Route to the copy of the mapping's :toTarget schema; a mapping
            // without one fans out to every copy (the pre-split reading).
            const copies = (t) => {
                const c = `${t}|${toTargetOf.get(q.subject.value)}`
                return copyInfo.has(c) ? [c] : copiesOf.get(t) ?? [t]
            }
            if (viaName) {
                const name = sourceName(fromSourceOf.get(q.subject.value))
                const via = `transform:${name}:${viaName}`
                if (!transformLabel.has(via)) { transformLabel.set(via, `${name}/${viaName}`); nodeSet.add(via) }
                for (const f of froms) pushOnce(f, via, "mapsTo")
                for (const t of tos) for (const c of copies(t)) pushOnce(via, c, "mapsTo", { toField: t })
            } else {
                for (const f of froms) for (const t of tos) for (const c of copies(t)) pushOnce(f, c, "mapsTo", { direct: true })
            }
        }
    }

    // SubFields render in the SourceField column — they're just nested fields.
    const typeFor = (iri) => {
        if (transformLabel.has(iri)) return "TransformNode"
        if (copyInfo.has(iri)) return "TargetField"
        const ts = typeOf.get(iri)
        if (ts?.has(SUB_FIELD)) return "SourceField"
        for (const t of NODE_TYPES) if (ts?.has(t)) return localName(t)
        return "Node"
    }

    // Keep only nodes forward-reachable from a visible source. Fixed-point
    // pass over `edges` until no new node is added.
    if (hiddenSources?.size) {
        const reachable = new Set([...nodeSet].filter((iri) =>
            typeOf.get(iri)?.has(`${NS}Source`) && !hiddenSources.has(iri)))
        for (let grew = true; grew;) {
            grew = false
            for (const e of edges) if (reachable.has(e.from) && !reachable.has(e.to)) { reachable.add(e.to); grew = true }
        }
        for (const iri of [...nodeSet]) if (!reachable.has(iri)) nodeSet.delete(iri)
    }

    // Track mapped-ness on both ends of mapsTo edges. Source fields are mapped
    // when they appear as `from`; target fields when they appear as `to`. Sub-
    // field parents inherit mapped-ness from any of their sub-fields. Unmapped
    // nodes are either hidden or tagged dashed for the caller to style.
    const mappedSources = new Set()
    const mappedTargets = new Set()
    for (const e of edges) if (e.label === "mapsTo") { mappedSources.add(e.from); mappedTargets.add(e.to) }
    for (const e of edges) if (e.label === "hasSubField" && mappedSources.has(e.to)) mappedSources.add(e.from)
    const isField = (iri) => {
        const ts = typeOf.get(iri)
        return ts?.has(`${NS}SourceField`) || ts?.has(SUB_FIELD)
    }
    const isTargetField = (iri) => copyInfo.has(iri) || (typeOf.get(iri)?.has(`${NS}TargetField`) ?? false)

    if (hideUnmappedFields) {
        for (const iri of [...nodeSet]) if (isField(iri) && !mappedSources.has(iri)) nodeSet.delete(iri)
    }
    if (hideUnmappedTargetFields) {
        for (const iri of [...nodeSet]) if (isTargetField(iri) && !mappedTargets.has(iri)) nodeSet.delete(iri)
    }
    const visibleEdges = edges.filter((e) => nodeSet.has(e.from) && nodeSet.has(e.to))

    // ---- Barycenter ordering (Sugiyama crossing-minimisation heuristic) ---
    // The target-field column is pinned by config (schema grouping), so one
    // downward pass suffices: every free node's barycenter is the MEAN column
    // index of the target-field copies it flows into (traced through transform
    // nodes), and sorting by it pulls connected nodes level. The sort nests to
    // keep containers intact: fields within their entity, units (entity
    // rectangles and loose fields) within their source, sub-fields under their
    // parent. Unmapped nodes have no barycenter (Infinity, ties kept stable)
    // and sink to the bottom of their container in declaration order.
    const copyIndex = new Map([...copyInfo.keys()].map((c, i) => [c, i]))
    const directCopies = new Map()  // node -> [copy ids]
    const viasOf       = new Map()  // field -> [transform nodes]
    for (const e of edges) {
        if (e.label !== "mapsTo") continue
        if (transformLabel.has(e.to)) appendTo(viasOf, e.from, e.to)
        else appendTo(directCopies, e.from, e.to)
    }
    const targetIndicesOf = (iri) => [
        ...(directCopies.get(iri) ?? []),
        ...(viasOf.get(iri) ?? []).flatMap((v) => directCopies.get(v) ?? []),
    ].map((c) => copyIndex.get(c)).filter((i) => i !== undefined)
    const barycenter = (idxs) => idxs.length ? idxs.reduce((a, b) => a + b, 0) / idxs.length : Infinity
    const byBarycenter = (xs, indices) =>
        xs.map((x) => [barycenter(indices(x)), x]).sort(([a], [b]) => (a === b ? 0 : a - b)).map(([, x]) => x)

    const subsOf = new Map()
    for (const [parent, sub] of subPairs) appendTo(subsOf, parent, sub)
    const blockIndices = (f) => [f, ...(subsOf.get(f) ?? [])].flatMap(targetIndicesOf)

    // An entity is one sortable unit (its rectangle stays contiguous); a loose
    // field is its own. Sources keep their declaration order.
    const unitsBySource = new Map()  // src -> Map<entityIri | fieldIri, fields[]>
    for (const [owner, field] of fieldPairs) {
        const src = sourceOfEntity.get(owner) ?? owner
        if (!unitsBySource.has(src)) unitsBySource.set(src, new Map())
        const units = unitsBySource.get(src)
        const key = sourceOfEntity.has(owner) ? owner : field
        if (!units.has(key)) units.set(key, [])
        units.get(key).push(field)
    }
    const sourceFieldOrder = []
    for (const units of unitsBySource.values()) {
        for (const fields of byBarycenter([...units.values()], (fs) => fs.flatMap(blockIndices))) {
            for (const f of byBarycenter(fields, blockIndices)) {
                sourceFieldOrder.push(f, ...byBarycenter(subsOf.get(f) ?? [], targetIndicesOf))
            }
        }
    }
    const transformOrder = byBarycenter([...transformLabel.keys()], targetIndicesOf)

    // Emission order drives ColumnGraph's stacking; the reordered columns go
    // first, everything else keeps nodeSet (declaration) order.
    const ordered = []
    const emitted = new Set()
    for (const iri of [...sourceFieldOrder, ...transformOrder]) {
        if (nodeSet.has(iri) && !emitted.has(iri)) { ordered.push(iri); emitted.add(iri) }
    }
    for (const iri of nodeSet) if (!emitted.has(iri)) ordered.push(iri)

    const schemaLabel = (iri) => labelOf.get(iri) ?? localName(iri)
    const labelFor = (iri) => {
        const tl = transformLabel.get(iri)
        if (tl) return tl
        const tp = targetPredicate.get(copyInfo.get(iri)?.field ?? iri)
        if (tp) return prefixedIri(tp)
        const fp = fieldPath.get(iri)
        if (fp) return fp
        if (typeOf.get(iri)?.has(`${NS}TargetSchema`)) return schemaLabel(iri)
        return localName(iri)
    }

    const nodes = ordered.map((iri) => ({
        id: iri,
        label: labelFor(iri),
        type: typeFor(iri),
        ...(copyInfo.has(iri) && { subtitle: schemaLabel(copyInfo.get(iri).schema) }),
        ...(groupOf.has(iri) && { group: groupOf.get(iri), groupLabel: labelOf.get(groupOf.get(iri)) ?? localName(groupOf.get(iri)) }),
        ...(((isField(iri) && !mappedSources.has(iri)) || (isTargetField(iri) && !mappedTargets.has(iri))) && { dashed: true }),
    }))
    return { nodes, edges: visibleEdges }
}
