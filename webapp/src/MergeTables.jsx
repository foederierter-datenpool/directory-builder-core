// Merge view: every entity with its per-source field values and conflict
// highlighting. An entity referencing another via a relationship the
// federation declares (mapping :hasRelationship → :toTargetField →
// :targetPredicate) renders nested beneath it.
// Reads:  mergedEntities from mergeEntities.js (← merged.ttl + provenance.ttl),
//         config/federation.ttl (relationship predicates)
// Does:   renders the Merge page (compact / wide <EntityCard>, toggleable)

import { CDP, parseTtl } from "@directory-builder/core/utils"
import { mergedEntities } from "./mergeEntities.js"
import { federationTtl } from "./instanceData.js"
import EntityCard from "./EntityCard.jsx"
import React, { useState } from "react"

const fedQuads = parseTtl(federationTtl)
const relFields = new Set(fedQuads.filter((q) => q.predicate.value === `${CDP}toTargetField`).map((q) => q.object.value))
const REL_PREDS = new Set(fedQuads.filter((q) => relFields.has(q.subject.value) && q.predicate.value === `${CDP}targetPredicate`).map((q) => q.object.value))

// An entity's parent = the first relationship value pointing at another merged
// entity. Entities keep their (conflict-sorted) order within each level.
const iris = new Set(mergedEntities.map((e) => e.iri))
const parentOf = (e) => e.fields.find((f) => REL_PREDS.has(f.predicate) && iris.has(f.values[0]?.raw))?.values[0].raw
const childrenOf = new Map()
const hasParent = new Set()
for (const e of mergedEntities) {
    const p = parentOf(e)
    if (!p || p === e.iri) continue
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    childrenOf.get(p).push(e)
    hasParent.add(e.iri)
}

// Flatten to (entity, depth) rows; the second pass catches reference cycles,
// which would otherwise never be reached from a top-level entity.
const ROWS = []
const seen = new Set()
const walk = (e, depth) => {
    if (seen.has(e.iri)) return
    seen.add(e.iri)
    ROWS.push({ e, depth })
    for (const c of childrenOf.get(e.iri) ?? []) walk(c, depth + 1)
}
for (const e of mergedEntities) if (!hasParent.has(e.iri)) walk(e, 0)
for (const e of mergedEntities) walk(e, 0)

export default function MergeTables() {
    const [compact, setCompact] = useState(true)
    const [highlight, setHighlight] = useState(true)
    return (
        <div className="page" style={{ overflowY: "auto", height: "100%" }}>
            <div style={{ display: "flex", gap: "1rem", marginBottom: "0.75rem", fontSize: 13 }}>
                <label style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                    <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />
                    Compact view
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                    <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} />
                    Highlight conflicts
                </label>
            </div>
            {ROWS.map(({ e, depth }) => (
                <div key={e.iri} style={depth ? { marginLeft: `${depth * 1.5}rem`, borderLeft: "2px solid #e0e0e0", paddingLeft: "0.75rem" } : undefined}>
                    <EntityCard entity={e} compact={compact} highlight={highlight} />
                </div>
            ))}
        </div>
    )
}
