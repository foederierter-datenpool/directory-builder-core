// Match "lanes" view, derived entirely from federation.ttl — no assumptions about
// how many entity types there are or how they relate. One lane per :TargetSchema
// (ordered by the relationship hierarchy, roots left), each preceded by a tinted
// "source duplications" column; cross-lane edges come from every :hasRelationship.
// When the relationships form a tree the layout groups each subtree vertically
// (parent centred on its children); otherwise it just lays out gracefully.
// Reads:  federation.ttl (schemas, classes, labels, relationships),
//         matches.ttl (clusters + hasMember), merged.ttl (rdf:type, name, links)
// Does:   returns everything <ColumnGraph> needs + a per-lane nodeY layout.

import { CDP as NS, localName, parseTtl, shrink, subjectsOfType } from "@directory-builder/core/utils"

const CDF = "https://civic-data.de/federated-directory#"
const S   = "http://schema.org/"
const RDF_TYPE   = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
const HAS_TARGET_SCHEMA = `${NS}hasTargetSchema`
const TARGET_CLASS      = `${NS}targetClass`
const TO_TARGET         = `${NS}toTarget`
const HAS_RELATIONSHIP  = `${NS}hasRelationship`
const TO_TARGET_SCHEMA  = `${NS}toTargetSchema`
const TO_TARGET_FIELD   = `${NS}toTargetField`
const TARGET_PREDICATE  = `${NS}targetPredicate`
const MATCH_CLUSTER = `${NS}MatchCluster`
const HAS_MEMBER    = `${NS}hasMember`
const NAME = `${S}name`
const CATEGORY = `${S}category`   // label fallback for entities with no name (e.g. AWO services)

const CLASS_PREFIXES = { schema: S, cdf: CDF }
// Lane colours, assigned by hierarchy position; cycles if there are more lanes.
const PALETTE = ["#cdddff", "#f7d2e3", "#cfe9d4", "#ffe2b8", "#e3d4f7", "#cfeef0", "#f3d9c0"]
const SRC_COLOR = "#e9e9ee"
const GAP = 84          // vertical spacing between single-member leaves
const SRC_GAP = 56      // spacing of a cluster's stacked source members
const NODE_H = 48       // approx node height — keeps source stacks from colliding
const MARGIN = GAP - NODE_H   // inter-cluster gap; keeps single-member spacing == GAP

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
// Mix a hex colour toward white by t∈[0,1] — the pale entity-column band tint.
const lighten = (hex, t) => {
    const n = parseInt(hex.slice(1), 16)
    const c = (sh) => { const v = (n >> sh) & 255; return Math.round(v + (255 - v) * t) }
    return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, "0")}`
}

// ---- federation.ttl → schema model -------------------------------------

function readSchemas(federationTtl) {
    const q = parseTtl(federationTtl)
    const order = []                  // schema IRIs in document order
    const targetClass = new Map()
    const label = new Map()           // any subject → its rdfs:label
    const toTarget = new Map()        // mapping → its :toTarget schema
    const relMapping = new Map()      // rel bnode → its mapping
    const relToSchema = new Map()     // rel bnode → :toTargetSchema
    const relToField = new Map()      // rel bnode → :toTargetField
    const fieldPred = new Map()       // target field → :targetPredicate
    for (const { subject: s, predicate: p, object: o } of q) {
        switch (p.value) {
            case HAS_TARGET_SCHEMA: order.push(o.value); break
            case TARGET_CLASS:      targetClass.set(s.value, o.value); break
            case RDFS_LABEL:        if (!label.has(s.value)) label.set(s.value, o.value); break
            case TO_TARGET:         toTarget.set(s.value, o.value); break
            case HAS_RELATIONSHIP:  relMapping.set(o.value, s.value); break
            case TO_TARGET_SCHEMA:  relToSchema.set(s.value, o.value); break
            case TO_TARGET_FIELD:   relToField.set(s.value, o.value); break
            case TARGET_PREDICATE:  fieldPred.set(s.value, o.value); break
        }
    }

    // Schema-level relationships: from = the mapping's :toTarget, to = :toTargetSchema,
    // predicate = the target field's :targetPredicate. Drives both the cross-lane
    // edges (by predicate) and the lane ordering (by the from→to graph).
    const relPreds = new Set()
    const out = new Map()             // schema → Set(schema it points at)
    for (const [rel, mapping] of relMapping) {
        const from = toTarget.get(mapping), to = relToSchema.get(rel)
        const pred = fieldPred.get(relToField.get(rel))
        if (!from || !to || !pred) continue
        relPreds.add(pred)
        if (!out.has(from)) out.set(from, new Set())
        out.get(from).add(to)
    }

    // Lane order: a schema sits left of anything that relates to it (a parent is
    // left of its children). level = longest chain of out-edges; roots (sinks) = 0.
    const docIdx = new Map(order.map((s, i) => [s, i]))
    const memo = new Map()
    const levelOf = (s, stack = new Set()) => {
        if (memo.has(s)) return memo.get(s)
        if (stack.has(s)) return 0                       // cycle guard
        stack.add(s)
        let lvl = 0
        for (const t of out.get(s) ?? []) lvl = Math.max(lvl, 1 + levelOf(t, stack))
        stack.delete(s)
        memo.set(s, lvl)
        return lvl
    }
    const ordered = [...order].sort((a, b) => levelOf(a) - levelOf(b) || docIdx.get(a) - docIdx.get(b))

    const lanes = ordered.map((schema, i) => {
        const cls = targetClass.get(schema)
        const name = label.get(schema) ?? (cls && label.get(cls)) ?? cap(localName(schema).replace(/Schema$/, ""))
        return {
            schema, cls,
            key: localName(schema).replace(/Schema$/, ""),
            label: name,
            title: `${name}\n${cls ? shrink(cls, CLASS_PREFIXES) : ""}`,
            color: PALETTE[i % PALETTE.length],
        }
    })
    return { lanes, relPreds }
}

// ---- main ---------------------------------------------------------------

export function loadMatch(federationTtl, matchesTtl, mergedTtl, { showDuplications = false, show1to1 = false } = {}) {
    const { lanes, relPreds } = readSchemas(federationTtl)
    const keyOfClass = new Map(lanes.filter((l) => l.cls).map((l) => [l.cls, l.key]))
    const laneIdx = new Map(lanes.map((l, i) => [l.key, i]))

    const columns = lanes.flatMap((l) => [`${l.key}Src`, l.key])
    const colors = {}, columnTitles = {}, columnBands = {}, columnHeaderStyle = {}
    for (const l of lanes) {
        colors[l.key] = l.color;        colors[`${l.key}Src`] = SRC_COLOR
        columnTitles[l.key] = l.title;  columnTitles[`${l.key}Src`] = "source duplications"
        columnBands[l.key] = lighten(l.color, 0.6)                          // entity column gets a brighter tint of its nodes
        columnHeaderStyle[`${l.key}Src`] = { fontSize: 10, color: "#aaa" }  // de-emphasise the source-column labels
    }

    const merged = parseTtl(mergedTtl)
    const tierOf = new Map()           // entity → lane key, via its rdf:type
    const nameOf = new Map(), catOf = new Map()
    for (const q of merged) {
        if (q.predicate.value === RDF_TYPE && keyOfClass.has(q.object.value)) tierOf.set(q.subject.value, keyOfClass.get(q.object.value))
        else if (q.predicate.value === NAME && !nameOf.has(q.subject.value)) nameOf.set(q.subject.value, q.object.value)
        else if (q.predicate.value === CATEGORY && !catOf.has(q.subject.value)) catOf.set(q.subject.value, q.object.value)
    }

    const quads = parseTtl(matchesTtl)
    const clusters = subjectsOfType(quads, MATCH_CLUSTER)
    const members = new Map()
    for (const q of quads) if (q.predicate.value === HAS_MEMBER) {
        if (!members.has(q.subject.value)) members.set(q.subject.value, [])
        members.get(q.subject.value).push(q.object.value)
    }

    const nodes = []
    const edges = []
    const nodeIds = new Set()
    for (const c of clusters) {
        const tier = tierOf.get(c)
        if (!tier) continue
        nodes.push({ id: c, type: tier, label: nameOf.get(c) ?? catOf.get(c) ?? localName(c), isCluster: true })
        nodeIds.add(c)
        const ms = members.get(c) ?? []
        if (!showDuplications || (!show1to1 && ms.length <= 1)) continue   // master off → no source cols; hide 1:1 unless "show 1:1"
        for (const src of ms) {
            nodes.push({ id: src, type: `${tier}Src`, label: localName(src) })
            nodeIds.add(src)
            edges.push({ from: src, to: c })           // dedup (hasMember) edge
        }
    }

    // Cross-lane links: any merged triple whose predicate is a declared relationship
    // and whose ends are both placed entities. Stored object→subject so the parent
    // (object) sits left of the child (subject) and edges flow toward the root.
    for (const q of merged) {
        if (relPreds.has(q.predicate.value) && q.object.termType === "NamedNode"
            && tierOf.has(q.subject.value) && tierOf.has(q.object.value)) {
            edges.push({ from: q.object.value, to: q.subject.value, rel: true })
        }
    }

    return { nodes, edges, members, lanes, columns, colors, columnTitles, columnBands, columnHeaderStyle,
             nodeY: layout(nodes, edges, members, nodeIds, laneIdx) }
}

// Tidy-tree vertical layout: place leaves on a running cursor, centre each parent
// on its children. Roots (entities with no parent) are ordered by lane, so the
// upper lanes' subtrees group at the top. Graceful on non-tree graphs: a node is
// placed once (first visit), so multiple parents / cycles can't loop or duplicate.
function layout(nodes, edges, members, nodeIds, laneIdx) {
    const childrenOf = new Map()
    const hasParent = new Set()
    for (const e of edges) if (e.rel) {
        if (!childrenOf.has(e.from)) childrenOf.set(e.from, [])
        childrenOf.get(e.from).push(e.to)
        hasParent.add(e.to)
    }

    const y = new Map()
    let cursor = 0
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length
    const place = (id) => {
        if (y.has(id)) return
        const kids = childrenOf.get(id) ?? []
        if (kids.length) { kids.forEach(place); y.set(id, mean(kids.map((k) => y.get(k)))) }
        else { y.set(id, cursor); cursor += GAP }
    }
    const clusters = nodes.filter((n) => n.isCluster)
    clusters.filter((n) => !hasParent.has(n.id)).sort((a, b) => laneIdx.get(a.type) - laneIdx.get(b.type)).forEach((n) => place(n.id))
    clusters.filter((n) => !y.has(n.id)).forEach((n) => place(n.id))   // safety net

    // When source columns are shown, push clusters apart within each lane so a
    // cluster's stacked source members never collide with its neighbours'.
    const stackHalf = (c) => (((members.get(c) ?? []).filter((m) => nodeIds.has(m)).length || 1) - 1) * SRC_GAP / 2 + NODE_H / 2
    if (nodes.some((n) => !n.isCluster)) {
        const byLane = new Map()
        for (const n of clusters) { if (!byLane.has(n.type)) byLane.set(n.type, []); byLane.get(n.type).push(n.id) }
        for (const ids of byLane.values()) {
            ids.sort((a, b) => y.get(a) - y.get(b))
            let prevBottom = -Infinity
            for (const id of ids) {
                const h = stackHalf(id)
                const cy = Math.max(y.get(id), prevBottom + MARGIN + h)
                y.set(id, cy); prevBottom = cy + h
            }
        }
    }

    for (const [c, ms] of members) {
        if (!y.has(c)) continue
        const shown = ms.filter((m) => nodeIds.has(m))
        shown.forEach((m, i) => y.set(m, y.get(c) + (i - (shown.length - 1) / 2) * SRC_GAP))
    }
    return y
}
