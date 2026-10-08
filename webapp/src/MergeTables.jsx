// Merge view: merged entities with their source values and conflicts. Hierarchical
// relationships group children beneath parents; address links do not.

import { CDP, NAMESPACES, parseTtl } from "@directory-builder/core/utils"
import { mergedEntities } from "./mergeEntities.js"
import { federationTtl } from "./instanceData.js"
import { schemaOptions } from "./filters.js"
import { loadSourceMeta } from "./sourceMeta.js"
import { useSourceParam } from "./useSourceParam.js"
import CheckboxDropdown from "./CheckboxDropdown.jsx"
import Dropdown from "./Dropdown.jsx"
import EntityCard, { isConflict } from "./EntityCard.jsx"
import { resolutionOf } from "./resolvePlan.js"
import HelpTip from "./HelpTip.jsx"
import Modal from "./Modal.jsx"
import React, { useEffect, useMemo, useRef, useState } from "react"

const PAGE_SIZE = 100

const fedQuads = parseTtl(federationTtl)
const targetClass = new Map(fedQuads.filter((q) => q.predicate.value === `${CDP}targetClass`).map((q) => [q.subject.value, q.object.value]))
const relTarget = new Map(fedQuads.filter((q) => q.predicate.value === `${CDP}toTargetSchema`).map((q) => [q.subject.value, q.object.value]))
const fieldPredicate = new Map(fedQuads.filter((q) => q.predicate.value === `${CDP}targetPredicate`).map((q) => [q.subject.value, q.object.value]))
// An address can be shared by several entities; its link is not a hierarchy.
const REL_PREDS = new Set(fedQuads
    .filter((q) => q.predicate.value === `${CDP}toTargetField`
        && targetClass.get(relTarget.get(q.subject.value)) !== `${NAMESPACES.schema}PostalAddress`)
    .map((q) => fieldPredicate.get(q.object.value)).filter(Boolean))
const SCHEMAS = schemaOptions(federationTtl)
const SCHEMA_OPTS = SCHEMAS.map((s) => ({ key: s.type, label: s.label }))
const tierLabel = new Map(SCHEMAS.map((s) => [s.type, s.label]))
const SOURCES = [...loadSourceMeta(federationTtl).values()]
const SOURCE_OPTS = SOURCES.map((s) => ({ key: s.iri, label: s.label }))

const menuItem = { display: "flex", alignItems: "center", gap: 6, padding: "2px 0", whiteSpace: "nowrap" }

// One-pass overview of all entities, including those outside the current filter.
const STATS = (() => {
    let multiRecord = 0, withConflicts = 0, records = 0
    const sources = new Set()
    const byTier = new Map()
    for (const e of mergedEntities) {
        const cols = e.columns ?? []
        records += cols.length
        cols.forEach((c) => c.source && sources.add(c.source))
        const hasMultipleRecords = cols.length > 1
        const hasConflict = e.fields.some((f) => isConflict(f))
        if (hasMultipleRecords) multiRecord++
        if (hasConflict) withConflicts++
        const t = byTier.get(e.type) ?? { total: 0, multiRecord: 0, conflicts: 0 }
        t.total++; if (hasMultipleRecords) t.multiRecord++; if (hasConflict) t.conflicts++
        byTier.set(e.type, t)
    }
    return { total: mergedEntities.length, multiRecord, withConflicts, records, sources: sources.size, byTier }
})()

const cell = { padding: "4px 8px" }
const cellR = { ...cell, textAlign: "right" }

function StatsModal({ onClose }) {
    return (
        <Modal title="Merge statistics" onClose={onClose}>
            <p style={{ fontSize: 13, margin: "0 0 12px" }}>
                {STATS.records} mapped records contribute to <b>{STATS.total}</b> entities from <b>{STATS.sources}</b> sources.
                Of those entities, <b>{STATS.multiRecord}</b> combine two or more records.
            </p>
            <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                <thead>
                    <tr style={{ textAlign: "left", color: "#666", borderBottom: "1px solid #ddd" }}>
                        <th style={cell}>Type</th><th style={cellR}>Entities</th><th style={cellR}>With multiple records</th><th style={cellR}>With conflicts</th>
                    </tr>
                </thead>
                <tbody>
                    {[...STATS.byTier].map(([type, t]) => (
                        <tr key={type} style={{ borderBottom: "1px solid #f0f0f0" }}>
                            <td style={cell}>{tierLabel.get(type) ?? type}</td><td style={cellR}>{t.total}</td><td style={cellR}>{t.multiRecord}</td><td style={cellR}>{t.conflicts}</td>
                        </tr>
                    ))}
                    <tr style={{ fontWeight: 600 }}>
                        <td style={cell}>Total</td><td style={cellR}>{STATS.total}</td><td style={cellR}>{STATS.multiRecord}</td><td style={cellR}>{STATS.withConflicts}</td>
                    </tr>
                </tbody>
            </table>
        </Modal>
    )
}

export default function MergeTables() {
    const [selected, setSelected] = useState(new Set(SCHEMAS.map((s) => s.type)))
    const [visibleSources, setVisibleSources, sourceMode, setSourceMode] = useSourceParam(SOURCES)  // mode: any = union, all = overlap
    const [group, setGroup] = useState(true)
    const [compact, setCompact] = useState(true)
    const [highlight, setHighlight] = useState(true)
    const [showStats, setShowStats] = useState(false)
    const [page, setPage] = useState(0)
    const listRef = useRef(null)

    const rows = useMemo(() => {
        const sel = visibleSources
        // any: entity any selected source fed into. all: only entities every
        // selected source fed into (their overlap) — empty selection shows nothing.
        const bySource = sourceMode === "all"
            ? (e) => sel.size > 0 && [...sel].every((s) => e.sources.includes(s))
            : (e) => e.sources.some((s) => sel.has(s))
        const visible = mergedEntities.filter((e) => selected.has(e.type) && bySource(e))
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
    }, [selected, visibleSources, sourceMode, group])
    useEffect(() => setPage(0), [selected, visibleSources, sourceMode, group])
    const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
    const currentPage = Math.min(page, pageCount - 1)
    const start = currentPage * PAGE_SIZE
    const end = Math.min(start + PAGE_SIZE, rows.length)
    const goToPage = (next) => {
        setPage(next)
        if (listRef.current) listRef.current.scrollTop = 0
    }

    return (
        <div className="page" style={{ boxSizing: "border-box", display: "flex", flexDirection: "column", height: "100%" }}>
            {showStats && <StatsModal onClose={() => setShowStats(false)} />}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
                <HelpTip title="The Merge view" label="About the Merge view">
                    <div>
                        Each entity shows its field values and their contributing sources.
                        A conflict means a field that expects one value has several, even when
                        all values came from one source. Hovering a
                        conflicted value shows how it settles: a curated correction (teal ✎), the
                        resolve strategy that picks which value reaches the directory, or both
                        when sources still disagree after the correction.
                        {" "}<em>Group by hierarchy</em> nests services under providers and
                        organisations under parent organisations. Address links do not imply a hierarchy.
                    </div>
                    <div>
                        The summary in the toolbar counts how many entities combine multiple records and
                        how many carry conflicts; click it for a per-type breakdown.
                    </div>
                </HelpTip>
                <CheckboxDropdown options={SCHEMA_OPTS} selected={selected} onChange={setSelected} noun="type" />
                <CheckboxDropdown options={SOURCE_OPTS} selected={visibleSources} onChange={setVisibleSources} noun="source"
                    matchMode={sourceMode} onMatchMode={setSourceMode} />
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
                    {STATS.multiRecord} entities with multiple records · {STATS.withConflicts} with conflicts
                    <span style={{ color: "#06c" }}> · see details</span>
                </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", margin: "0.5rem 0", fontSize: 13, color: "#666" }}>
                <span>Showing {rows.length ? `${start + 1}–${end}` : "0"} of {rows.length} matching entities (page {currentPage + 1} of {pageCount}).</span>
                {currentPage > 0 && <button onClick={() => goToPage(currentPage - 1)}>Previous</button>}
                {currentPage + 1 < pageCount && <button onClick={() => goToPage(currentPage + 1)}>Next</button>}
            </div>
            <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                {rows.slice(start, end).map(({ e, depth }) => (
                    <div key={e.iri} style={depth ? { marginLeft: `${depth * 1.5}rem`, borderLeft: "2px solid #e0e0e0", paddingLeft: "0.75rem" } : undefined}>
                        <EntityCard entity={e} compact={compact} highlight={highlight} resolutionOf={resolutionOf} />
                    </div>
                ))}
            </div>
        </div>
    )
}
