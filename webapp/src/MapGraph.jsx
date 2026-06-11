// Map view: the source-schema → target-schema mapping graph, optionally animated
// with one entity's field values flowing through the transform nodes.
// Reads:  config/federation.ttl, data/pipeline/mapped.ttl,
//         data/pipeline/cleaned/*.ttl (via loadMap.js + sourceMeta.js)
// Does:   renders the Map page (horizontal <ColumnGraph>)

import { federationTtl as ttl, mappedTtl, cleanedByPath } from "./instanceData.js"
import { loadMap, loadSources, loadEntitiesBySource, loadFieldValuesByEntity } from "./loadMap.js"
import React, { useEffect, useMemo, useRef, useState } from "react"
import { loadCleanedBySource } from "./sourceMeta.js"
import { SkipBack, SkipForward } from "lucide-react"
import ColumnGraph from "./ColumnGraph.jsx"

const COLUMNS = ["Source", "SourceField", "TransformNode", "TargetField", "TargetSchema"]
// The short columns anchor at the vertical middle of what they connect to —
// a source at its fields, a schema at its target-field copies.
const ANCHOR_COLUMNS = ["Source", "TransformNode", "TargetSchema"]
const COLORS = {
    Source: "#d4e7ff",
    SourceField: "#e6f3d8",
    TransformNode: "#fff1a8",
    TargetField: "#fde2c7",
    TargetSchema: "#f4cfe0",
}
// Lighter tints than the node fills so labels read as belonging to the same
// column/moment without competing for attention against the nodes themselves.
const VALUE_LABEL_BG = {
    SourceField:   "#f0f8e0",
    TransformNode: "#fff8c8",
}

const SOURCES = loadSources(ttl)
const ENTITIES_BY_SOURCE = loadEntitiesBySource(ttl, mappedTtl)
// Source-to-file mapping is resolved from config: instanceData enumerates the
// cleaned TTLs from :hasSource, so a new source needs no edit here.
const FIELD_VALUES = loadFieldValuesByEntity(ttl, mappedTtl, loadCleanedBySource(ttl, cleanedByPath))

function SourcesDropdown({ visible, onChange }) {
    const [open, setOpen] = useState(false)
    const ref = useRef(null)

    useEffect(() => {
        if (!open) return
        const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
        document.addEventListener("mousedown", onDown)
        return () => document.removeEventListener("mousedown", onDown)
    }, [open])

    const summary = visible.size === SOURCES.length
        ? "All sources"
        : visible.size === 0
            ? "No sources"
            : `${visible.size} of ${SOURCES.length} sources`

    const toggle = (iri) => {
        const next = new Set(visible)
        if (next.has(iri)) next.delete(iri); else next.add(iri)
        onChange(next)
    }
    const setAll = (on) => onChange(on ? new Set(SOURCES.map(s => s.iri)) : new Set())

    const linkBtn = { background: "none", border: "none", color: "#06c", cursor: "pointer", padding: 0, fontSize: 12 }

    return (
        <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
            <button onClick={() => setOpen(!open)} style={{ padding: "0.25rem 0.6rem", border: "1px solid #aaa", borderRadius: 4, background: "white", cursor: "pointer", fontSize: 13 }}>
                {summary} ▾
            </button>
            {open && (
                <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 10, background: "white", border: "1px solid #aaa", borderRadius: 4, padding: 6, minWidth: 200, boxShadow: "0 2px 6px rgba(0,0,0,0.12)" }}>
                    <div style={{ display: "flex", gap: 12, paddingBottom: 4, marginBottom: 4, borderBottom: "1px solid #eee" }}>
                        <button onClick={() => setAll(true)} style={linkBtn}>Select all</button>
                        <button onClick={() => setAll(false)} style={linkBtn}>Unselect all</button>
                    </div>
                    {SOURCES.map(s => (
                        <label key={s.iri} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0" }}>
                            <input type="checkbox" checked={visible.has(s.iri)} onChange={() => toggle(s.iri)} />
                            {s.label}
                        </label>
                    ))}
                </div>
            )}
        </div>
    )
}

// If an element is selected on the board, the content lands a bit below it;
// otherwise at the board origin. (Consoles support top-level await.)
const MIRO_SNIPPET = `const [sel] = await miro.board.getSelection()
miro.board.createStickyNote({
    content: "hello123",
    x: sel?.x ?? 0,
    y: sel ? sel.y + (sel.height ?? 100) : 0,
})
`

// "Export to Miro" button + explainer modal. The export needs no Miro app or
// API key: the Miro Web SDK is exposed as `miro.board` in the browser console
// of any open board, so users just paste the copied snippet there.
// https://developers.miro.com/docs/use-the-developer-tools-with-the-miro-web-sdk
const BTN     = { padding: "0.25rem 0.6rem", border: "1px solid #aaa", borderRadius: 4, background: "white", cursor: "pointer", fontSize: 13 }
const OVERLAY = { position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }
const CARD    = { background: "white", borderRadius: 6, padding: "1.25rem 1.5rem", width: 480, maxWidth: "90vw", boxShadow: "0 6px 24px rgba(0,0,0,0.25)", fontSize: 13, lineHeight: 1.5 }

function MiroExport() {
    const [open, setOpen] = useState(false)
    const [copied, setCopied] = useState(false)
    const copy = () => navigator.clipboard.writeText(MIRO_SNIPPET).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    })
    return (
        <>
            <button onClick={() => setOpen(true)} style={BTN}>Export to Miro</button>
            {open && (
                <div onClick={() => setOpen(false)} style={OVERLAY}>
                    <div onClick={(e) => e.stopPropagation()} style={CARD}>
                        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                            <strong style={{ fontSize: 15 }}>Export to Miro</strong>
                            <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#888" }}>✕</button>
                        </div>
                        <p style={{ margin: "0.5rem 0 0" }}>Recreate this Map on a Miro board. Works via the Miro Web SDK.</p>
                        <ol style={{ margin: "0.5rem 0 0.75rem", paddingLeft: "1.25rem" }}>
                            <li>Open a Miro board you have edit rights on</li>
                            <li>Open the browser's developer console</li>
                            <li>Paste the copied code and press Enter</li>
                        </ol>
                        <button onClick={copy} style={BTN}>Copy code to clipboard</button>
                        {copied && <span style={{ color: "#2a7d2a", marginLeft: "0.75rem" }}>Copied!</span>}
                    </div>
                </div>
            )}
        </>
    )
}

function EntityCombobox({ entities, value, onChange, disabled }) {
    const [open, setOpen] = useState(false)
    const [filter, setFilter] = useState("")
    const ref = useRef(null)

    useEffect(() => {
        if (!open) return
        const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
        document.addEventListener("mousedown", onDown)
        return () => document.removeEventListener("mousedown", onDown)
    }, [open])

    const selected = entities.find(o => o.iri === value)
    const f = filter.toLowerCase()
    const filtered = f ? entities.filter(o => o.id.toLowerCase().includes(f) || o.name.toLowerCase().includes(f)) : entities

    return (
        <div ref={ref} style={{ position: "relative" }}>
            <input
                type="text"
                disabled={disabled}
                value={open ? filter : (selected?.name || selected?.id || "")}
                placeholder={disabled ? "" : "Pick entity…"}
                onChange={(e) => { setFilter(e.target.value); if (!open) setOpen(true) }}
                onFocus={() => { setFilter(""); setOpen(true) }}
                style={{
                    padding: "0.25rem 0.5rem",
                    border: "1px solid #aaa",
                    borderRadius: 4,
                    fontSize: 13,
                    width: 250,
                    background: disabled ? "#f4f4f4" : "white",
                    color: disabled ? "#bbb" : "#000",
                }}
            />
            {open && filtered.length > 0 && (
                <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 10, background: "white", border: "1px solid #aaa", borderRadius: 4, maxHeight: 280, overflowY: "auto", minWidth: "100%", boxShadow: "0 2px 6px rgba(0,0,0,0.12)" }}>
                    {filtered.slice(0, 200).map(o => (
                        <div
                            key={o.iri}
                            onClick={() => { onChange(o.iri); setOpen(false); setFilter("") }}
                            title={o.name}
                            style={{ padding: "4px 8px", cursor: "pointer", borderBottom: "1px solid #eee" }}
                        >
                            <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320 }}>{o.name || <span style={{ color: "#999" }}>(no name)</span>}</div>
                            <div style={{ fontFamily: "monospace", fontSize: 11, color: "#666" }}>{o.id}</div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

export default function MapGraph() {
    const [visible, setVisible] = useState(() => new Set(SOURCES.map(s => s.iri)))
    const [selectedEntity, setSelectedEntity] = useState(null)
    const [dataFlow, setDataFlow] = useState(false)
    const [showUnmapped, setShowUnmapped] = useState(false)
    const [showAllTargets, setShowAllTargets] = useState(false)
    const [showDirectFlows, setShowDirectFlows] = useState(false)

    const { nodes, edges: rawEdges } = useMemo(() => {
        const hiddenSources = new Set(SOURCES.filter(s => !visible.has(s.iri)).map(s => s.iri))
        return loadMap(ttl, { hiddenSources, hideUnmappedFields: !showUnmapped, hideUnmappedTargetFields: !showAllTargets })
    }, [visible, showUnmapped, showAllTargets])

    const oneActive = visible.size === 1
    const enabled = dataFlow && oneActive
    const valueByField = enabled && selectedEntity ? FIELD_VALUES.get(selectedEntity) : null
    const edges = useMemo(() => {
        if (!valueByField) return rawEdges
        const typeOf = new Map(nodes.map(n => [n.id, n.type]))
        return rawEdges.map(e => {
            // Source-field outgoing: source literal. Transform outgoing: the
            // post-transform target field value (the value that lands in `to`).
            // The label tints with the from-node's column color so labels read
            // as belonging to the same "moment" in the transformation.
            // Direct (no-:via) source-field → target-field edges are gated
            // behind the "Also show 1:1 flows" toggle.
            if (e.direct && !showDirectFlows) return e
            const fromType = typeOf.get(e.from)
            const v = fromType === "TransformNode" ? valueByField.get(e.toField ?? e.to)
                : fromType === "SourceField"       ? valueByField.get(e.from)
                : undefined
            return v ? { ...e, value: v, valueBg: VALUE_LABEL_BG[fromType] } : e
        })
    }, [rawEdges, nodes, valueByField, showDirectFlows])

    // Remount when the visible node set changes (sources or unmapped-fields
    // toggle). Entity / data-flow changes only update edge labels in place.
    const graphKey = useMemo(() => `${[...visible].sort().join("|")}::${showUnmapped ? "all" : "mapped"}::${showAllTargets ? "allT" : "mappedT"}`, [visible, showUnmapped, showAllTargets])

    const activeSource = oneActive ? [...visible][0] : null
    const entities = activeSource ? (ENTITIES_BY_SOURCE.get(activeSource) ?? []) : []

    useEffect(() => {
        if (entities.length > 0) {
            if (!entities.find(o => o.iri === selectedEntity)) setSelectedEntity(entities[0].iri)
        } else if (selectedEntity !== null) {
            setSelectedEntity(null)
        }
    }, [entities])

    useEffect(() => {
        if (!oneActive && dataFlow) setDataFlow(false)
    }, [oneActive])

    const cycle = (delta) => {
        if (entities.length === 0) return
        const idx = entities.findIndex(o => o.iri === selectedEntity)
        const next = ((idx < 0 ? 0 : idx + delta) + entities.length) % entities.length
        setSelectedEntity(entities[next].iri)
    }

    const disabledHint = !dataFlow
        ? "Enable Show data flow to use these controls"
        : "Active only when exactly one source is selected"
    const iconBtnStyle = {
        display: "inline-flex",
        alignItems: "center",
        background: "none",
        border: "1px solid #aaa",
        borderRadius: 4,
        padding: "0.25rem 0.5rem",
        cursor: enabled ? "pointer" : "not-allowed",
        color: enabled ? "#000" : "#bbb",
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 1rem", fontSize: 13, borderBottom: "1px solid #ddd" }}>
                <SourcesDropdown visible={visible} onChange={setVisible} />
                <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                    <input type="checkbox" checked={showUnmapped} onChange={(e) => setShowUnmapped(e.target.checked)} />
                    Show all source fields
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                    <input type="checkbox" checked={showAllTargets} onChange={(e) => setShowAllTargets(e.target.checked)} />
                    Show all target fields
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", color: oneActive ? "#000" : "#bbb", cursor: oneActive ? "pointer" : "not-allowed" }} title={oneActive ? "" : "Active only when exactly one source is selected"}>
                    <input type="checkbox" disabled={!oneActive} checked={dataFlow} onChange={(e) => setDataFlow(e.target.checked)} />
                    Show data flow
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", color: enabled ? "#000" : "#bbb", cursor: enabled ? "pointer" : "not-allowed" }} title={enabled ? "" : "Enable Show data flow first"}>
                    <input type="checkbox" disabled={!enabled} checked={showDirectFlows} onChange={(e) => setShowDirectFlows(e.target.checked)} />
                    Also show 1:1 flows
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                    <button disabled={!enabled} onClick={() => cycle(-1)} title={enabled ? "Previous" : disabledHint} style={iconBtnStyle}><SkipBack size={13} fill="currentColor" /></button>
                    <EntityCombobox entities={entities} value={selectedEntity} onChange={setSelectedEntity} disabled={!enabled} />
                    <button disabled={!enabled} onClick={() => cycle(1)} title={enabled ? "Next" : disabledHint} style={iconBtnStyle}><SkipForward size={13} fill="currentColor" /></button>
                </div>
                <MiroExport />
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                <ColumnGraph key={graphKey} nodes={nodes} edges={edges} columns={COLUMNS} colors={COLORS} anchorColumns={ANCHOR_COLUMNS} />
            </div>
        </div>
    )
}
