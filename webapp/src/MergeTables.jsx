// Merge view: every entity with its per-source field values and conflict
// highlighting. An entity referencing another via a relationship the federation
// declares (mapping :hasRelationship → :toTargetField → :targetPredicate) renders
// nested beneath it when grouped.
// Reads:  mergedEntities from mergeEntities.js (← merged.ttl + provenance.ttl),
//         config/federation.ttl (relationship predicates + schemas)
// Does:   renders the Merge page — a Types filter, a View options dropdown, an
//         info-bar (click for stats), and the entity cards.

import { CDP, parseTtl } from "@directory-builder/core/utils"
import { mergedEntities } from "./mergeEntities.js"
import { federationTtl } from "./instanceData.js"
import { schemaOptions } from "./filters.js"
import CheckboxDropdown from "./CheckboxDropdown.jsx"
import Dropdown from "./Dropdown.jsx"
import EntityCard, { isConflict } from "./EntityCard.jsx"
import Modal from "./Modal.jsx"
import React, { useMemo, useState } from "react"

const fedQuads = parseTtl(federationTtl)
const relFields = new Set(fedQuads.filter((q) => q.predicate.value === `${CDP}toTargetField`).map((q) => q.object.value))
const REL_PREDS = new Set(fedQuads.filter((q) => relFields.has(q.subject.value) && q.predicate.value === `${CDP}targetPredicate`).map((q) => q.object.value))
const SCHEMAS = schemaOptions(federationTtl)
const SCHEMA_OPTS = SCHEMAS.map((s) => ({ key: s.type, label: s.label }))
const tierLabel = new Map(SCHEMAS.map((s) => [s.type, s.label]))

const menuItem = { display: "flex", alignItems: "center", gap: 6, padding: "2px 0", whiteSpace: "nowrap" }

// One-pass overview of the whole merge result (not the filtered view): how many
// entities, how many were deduplicated (>1 contributing record), across how many
// sources, and how many carry field conflicts — with a per-tier breakdown.
const STATS = (() => {
    let merged = 0, withConflicts = 0, records = 0
    const sources = new Set()
    const byTier = new Map()                       // entity.type → { total, merged, conflicts }
    for (const e of mergedEntities) {
        const cols = e.columns ?? []
        records += cols.length
        cols.forEach((c) => c.source && sources.add(c.source))
        const isMrg = cols.length > 1
        const hasConflict = e.fields.some((f) => isConflict(f))
        if (isMrg) merged++
        if (hasConflict) withConflicts++
        const t = byTier.get(e.type) ?? { total: 0, merged: 0, conflicts: 0 }
        t.total++; if (isMrg) t.merged++; if (hasConflict) t.conflicts++
        byTier.set(e.type, t)
    }
    return { total: mergedEntities.length, merged, withConflicts, records, sources: sources.size, byTier }
})()

const cell = { padding: "4px 8px" }
const cellR = { ...cell, textAlign: "right" }

function StatsModal({ onClose }) {
    return (
        <Modal title="Merge statistics" onClose={onClose}>
            <p style={{ fontSize: 13, margin: "0 0 12px" }}>
                {STATS.records} source records merged into <b>{STATS.total}</b> entities, across <b>{STATS.sources}</b> sources.
            </p>
            <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                <thead>
                    <tr style={{ textAlign: "left", color: "#666", borderBottom: "1px solid #ddd" }}>
                        <th style={cell}>Tier</th><th style={cellR}>Entities</th><th style={cellR}>Deduplicated</th><th style={cellR}>With conflicts</th>
                    </tr>
                </thead>
                <tbody>
                    {[...STATS.byTier].map(([type, t]) => (
                        <tr key={type} style={{ borderBottom: "1px solid #f0f0f0" }}>
                            <td style={cell}>{tierLabel.get(type) ?? type}</td><td style={cellR}>{t.total}</td><td style={cellR}>{t.merged}</td><td style={cellR}>{t.conflicts}</td>
                        </tr>
                    ))}
                    <tr style={{ fontWeight: 600 }}>
                        <td style={cell}>Total</td><td style={cellR}>{STATS.total}</td><td style={cellR}>{STATS.merged}</td><td style={cellR}>{STATS.withConflicts}</td>
                    </tr>
                </tbody>
            </table>
        </Modal>
    )
}

export default function MergeTables() {
    const [selected, setSelected] = useState(new Set(SCHEMAS.map((s) => s.type)))
    const [group, setGroup] = useState(true)
    const [compact, setCompact] = useState(true)
    const [highlight, setHighlight] = useState(true)
    const [showStats, setShowStats] = useState(false)

    const rows = useMemo(() => {
        const visible = mergedEntities.filter((e) => selected.has(e.type))
        if (!group) return visible.map((e) => ({ e, depth: 0 }))

        // Hierarchy over the surviving set only: a child whose parent was filtered
        // out becomes a root, so it stays visible. Order follows mergedEntities.
        const vset = new Set(visible.map((e) => e.iri))
        const parentOf = (e) => {
            const f = e.fields.find((f) => REL_PREDS.has(f.predicate) && f.values[0]?.raw && vset.has(f.values[0].raw) && f.values[0].raw !== e.iri)
            return f ? f.values[0].raw : null
        }
        const childrenOf = new Map(), hasParent = new Set()
        for (const e of visible) {
            const p = parentOf(e)
            if (!p) continue
            if (!childrenOf.has(p)) childrenOf.set(p, [])
            childrenOf.get(p).push(e)
            hasParent.add(e.iri)
        }
        const out = [], seen = new Set()
        const walk = (e, depth) => {
            if (seen.has(e.iri)) return
            seen.add(e.iri)
            out.push({ e, depth })
            for (const c of childrenOf.get(e.iri) ?? []) walk(c, depth + 1)
        }
        visible.filter((e) => !hasParent.has(e.iri)).forEach((e) => walk(e, 0))
        visible.forEach((e) => walk(e, 0))   // catch reference cycles
        return out
    }, [selected, group])

    return (
        <div className="page" style={{ overflowY: "auto", height: "100%" }}>
            {showStats && <StatsModal onClose={() => setShowStats(false)} />}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
                <CheckboxDropdown options={SCHEMA_OPTS} selected={selected} onChange={setSelected} noun="type" />
                <Dropdown label="View">
                    <label style={menuItem}>
                        <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} /> Group by hierarchy
                    </label>
                    <label style={menuItem}>
                        <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} /> Compact view
                    </label>
                    <label style={menuItem}>
                        <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} /> Highlight conflicts
                    </label>
                </Dropdown>
                <button onClick={() => setShowStats(true)} title="Click for more statistics"
                    style={{ marginLeft: "0.5rem", border: 0, background: "transparent", padding: 0, fontSize: 12, color: "#666", cursor: "pointer" }}>
                    {STATS.merged} deduplications across {STATS.sources} sources · {STATS.withConflicts} with conflicts
                    <span style={{ color: "#06c" }}> · see details</span>
                </button>
            </div>
            {rows.map(({ e, depth }) => (
                <div key={e.iri} style={depth ? { marginLeft: `${depth * 1.5}rem`, borderLeft: "2px solid #e0e0e0", paddingLeft: "0.75rem" } : undefined}>
                    <EntityCard entity={e} compact={compact} highlight={highlight} />
                </div>
            ))}
        </div>
    )
}
