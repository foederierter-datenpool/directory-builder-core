// Helpers for the Entities view. Pure (ttl in → graph out). Two lenses on the
// same federation.ttl:
//   loadEntities    — the derivation FLOW: source → typed entity → target schema
//   loadEntityLinks — the output RELATIONSHIPS between the resulting entities,
//                     collapsed to a source-independent schema↔schema graph
// (Complements the Map view's field-level dimension.)

import { CDP as NS, localName, NAMESPACES, parseTtl, subjectsOfType } from "@directory-builder/core/utils"

const RDFS_LABEL = `${NAMESPACES.rdfs}label`
const P = (x) => `${NS}${x}`

// Single pass over the config, shared by both lenses.
function parseFederation(ttl) {
    const quads = parseTtl(ttl)
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v) }
    const f = {
        labelOf: new Map(), schemaOrder: [], entitiesOfSource: new Map(),
        fieldToEntity: new Map(), subToParent: new Map(), targetPredicate: new Map(),
        fromSource: new Map(), toTarget: new Map(), fieldMappings: new Map(),
        relationships: new Map(), bFrom: new Map(), bPredicate: new Map(), bToField: new Map(), bToSchema: new Map(),
    }
    for (const q of quads) {
        const p = q.predicate.value, s = q.subject.value, o = q.object.value
        if      (p === RDFS_LABEL)           f.labelOf.set(s, o)
        else if (p === P("hasTargetSchema")) f.schemaOrder.push(o)
        else if (p === P("hasEntity"))       push(f.entitiesOfSource, s, o)
        else if (p === P("hasField"))        f.fieldToEntity.set(o, s)
        else if (p === P("hasSubField"))     f.subToParent.set(o, s)
        else if (p === P("targetPredicate")) f.targetPredicate.set(s, o)
        else if (p === P("fromSource"))      f.fromSource.set(s, o)
        else if (p === P("toTarget"))        f.toTarget.set(s, o)
        else if (p === P("hasFieldMapping")) push(f.fieldMappings, s, o)
        else if (p === P("hasRelationship")) push(f.relationships, s, o)
        else if (p === P("from"))            f.bFrom.set(s, o)
        else if (p === P("sourcePredicate")) f.bPredicate.set(s, o)
        else if (p === P("toTargetField"))   f.bToField.set(s, o)
        else if (p === P("toTargetSchema"))  f.bToSchema.set(s, o)
    }
    f.sources = [...subjectsOfType(quads, P("Source"))]
    f.label = (iri) => f.labelOf.get(iri) ?? localName(iri)
    f.visibleSet = (hidden) => new Set(f.sources.filter((s) => !hidden?.has(s)))
    return f
}

// The derivation flow. hiddenSources drops whole sources; schemas render only
// when a visible entity realises them, in :hasTargetSchema declaration order.
export function loadEntities(ttl, { hiddenSources } = {}) {
    const f = parseFederation(ttl)
    const visible = f.visibleSet(hiddenSources)
    // A mapping's :from fields all belong to one :SourceEntity (its subject);
    // sub-fields resolve through their parent field.
    const ownerEntity = (field) => f.fieldToEntity.get(field) ?? f.fieldToEntity.get(f.subToParent.get(field))

    const nodes = []
    const edges = []
    const usedSchemas = new Set()
    const seen = new Set()
    const addEdge = (from, to) => { const k = `${from}|${to}`; if (!seen.has(k)) { seen.add(k); edges.push({ from, to }) } }

    // Source → Entity: the record fanning out into its typed entities, kept
    // contiguous per source so a source's entities stack together in the column.
    // A flat source (fields hung straight off it via :hasField, no :hasEntity)
    // has no split to draw, so it contributes only its own node and reaches its
    // schema directly — hence iterating every source, not just the splitting ones.
    for (const src of f.sources) {
        if (!visible.has(src)) continue
        nodes.push({ id: src, label: f.label(src), type: "Source" })
        for (const ent of f.entitiesOfSource.get(src) ?? []) {
            nodes.push({ id: ent, label: f.label(ent), type: "Entity" })
            addEdge(src, ent)
        }
    }
    // Entity → its :toTarget schema (realisation). Split + realisation are the
    // whole flow; links between the resulting entities live in loadEntityLinks.
    for (const [mapping, src] of f.fromSource) {
        if (!visible.has(src)) continue
        const subject = (f.fieldMappings.get(mapping) ?? []).map((b) => ownerEntity(f.bFrom.get(b))).find(Boolean)
        const schema = f.toTarget.get(mapping)
        if (subject && schema) { addEdge(subject, schema); usedSchemas.add(schema) }
    }
    // Emit reached schemas in :hasTargetSchema declaration order; ColumnGraph
    // (orderColumns) then reorders the column into crossing-minimising order,
    // rendered as an evenly-spaced block centred against the entity column.
    for (const schema of f.schemaOrder) if (usedSchemas.has(schema)) nodes.push({ id: schema, label: f.label(schema), type: "TargetSchema" })
    return { nodes, edges }
}

// The output relationships (:hasRelationship), collapsed to schema↔schema: the
// subject is the mapping's :toTarget, the object its :toTargetSchema. Each edge is
// labelled by the OUTPUT predicate (:toTargetField's :targetPredicate, e.g.
// schema:address) — the data model's own vocabulary — not the source-side
// :sourcePredicate that feeds it, which belongs to the extract mechanics. Deduped
// across the selected sources, so it reads as the output data model rather than
// per-source. Schemas are layered by longest path so links flow left→right, with
// an odd/even vertical stagger (nodeY) that keeps skip-edges clear of the nodes
// they pass over. Returns extra { columns, nodeY } for ColumnGraph.
export function loadEntityLinks(ttl, { hiddenSources } = {}) {
    const f = parseFederation(ttl)
    const visible = f.visibleSet(hiddenSources)

    const relEdges = []
    const usedSchemas = new Set()
    const seen = new Set()
    for (const [mapping, src] of f.fromSource) {
        if (!visible.has(src)) continue
        const from = f.toTarget.get(mapping)
        if (!from) continue
        for (const rel of f.relationships.get(mapping) ?? []) {
            const to = f.bToSchema.get(rel)
            if (!to) continue
            // Label by the output predicate; fall back to the source predicate.
            const relType = localName(f.targetPredicate.get(f.bToField.get(rel)) ?? f.bPredicate.get(rel) ?? "")
            const k = `${from}|${to}|${relType}`
            if (seen.has(k)) continue
            seen.add(k)
            relEdges.push({ from, to, relType })
            usedSchemas.add(from); usedSchemas.add(to)
        }
    }
    // Stable order (independent of which sources are selected) so each edge keeps
    // its array index — the label offset is index-derived, so this keeps labels
    // from jumping when the selection changes without changing the deduped set.
    relEdges.sort((a, b) =>
        (f.schemaOrder.indexOf(a.from) - f.schemaOrder.indexOf(b.from)) ||
        (f.schemaOrder.indexOf(a.to) - f.schemaOrder.indexOf(b.to)) ||
        a.relType.localeCompare(b.relType))

    // Longest-path layering (bounded relaxation, safe on cycles): edge a→b puts
    // b at least one column right of a, so every link points forward.
    const layer = new Map([...usedSchemas].map((s) => [s, 0]))
    for (let i = 0; i < usedSchemas.size; i++)
        for (const e of relEdges) layer.set(e.to, Math.max(layer.get(e.to), layer.get(e.from) + 1))
    const maxLayer = Math.max(0, ...layer.values())
    const columns = Array.from({ length: maxLayer + 1 }, (_, i) => `L${i}`)

    // Within a layer keep :hasTargetSchema order; stagger rows by layer parity so
    // a link skipping an intermediate column clears the node sitting there.
    const sorted = [...usedSchemas].sort((a, b) =>
        (layer.get(a) - layer.get(b)) || (f.schemaOrder.indexOf(a) - f.schemaOrder.indexOf(b)))
    const STAGGER = 300, GAP = 200
    const nextRow = new Map()
    const nodeY = new Map()
    const nodes = sorted.map((s) => {
        const L = layer.get(s)
        const row = nextRow.get(L) ?? 0
        nextRow.set(L, row + 1)
        nodeY.set(s, (L % 2) * STAGGER + row * GAP)
        return { id: s, label: f.label(s), type: `L${L}` }
    })
    return { nodes, edges: relEdges, columns, nodeY }
}
