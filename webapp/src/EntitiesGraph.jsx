// Entities view: how each source becomes the federated model, in two modes
// (switched at the top, remembered in the URL as ?view=flow|links):
//   "Extractable entities" (flow)  — the derivation: source record → typed
//           entities → target schema
//   "Target entity relationships" (links) — the output relationships
//           (:hasRelationship) between the resulting entities, as a
//           source-independent schema↔schema graph
// The entity DIMENSION, complementing the Map view's field-level journey.
// Reads:  config/federation.ttl (via loadEntities.js)

import { federationTtl as ttl } from "./instanceData.js"
import { loadEntities, loadEntityLinks } from "./loadEntities.js"
import { loadSources } from "./loadMap.js"
import { useSourceParam } from "./useSourceParam.js"
import React, { useMemo } from "react"
import { useSearchParams } from "react-router-dom"
import ColumnGraph from "./ColumnGraph.jsx"
import CheckboxDropdown from "./CheckboxDropdown.jsx"
import InfoTip from "./InfoTip.jsx"

const SOURCES = loadSources(ttl)
const SOURCE_OPTS = SOURCES.map((s) => ({ key: s.iri, label: s.label }))

// Flow mode: cool → warm across the columns; lavender for the entity column is a
// hue the Map view doesn't use elsewhere, so it reads as its own thing.
const FLOW_COLUMNS = ["Source", "Entity", "TargetSchema"]
const FLOW_COLORS = { Source: "#d4e7ff", Entity: "#e8e0f7", TargetSchema: "#f4cfe0" }
const FLOW_TITLES = { Source: "Source", Entity: "Entity", TargetSchema: "Target schema" }
const SCHEMA_FILL = "#f4cfe0"
// Wider than the default so edge labels between columns have room to spread.
const COL_SPACING = 380

// Each :hasRelationship predicate gets its own link colour (and a light label
// tint to match) so the different link kinds read apart at a glance.
const REL_COLORS = { locatedAt: "#0d9488", providedBy: "#d97706", hasParent: "#4f46e5" }
const REL_BG     = { locatedAt: "#d7f0ed", providedBy: "#fdebd3", hasParent: "#e2e0fb" }
const REL_FALLBACK = "#9333ea"
const relColor = (t) => REL_COLORS[t] ?? REL_FALLBACK
const relBg = (t) => REL_BG[t] ?? "#efe6fb"

const MODES = [
    { key: "flow", label: "Extractable entities" },
    { key: "links", label: "Target entity relationships" },
]

// Gentle, instance-agnostic guidance shown behind the ? icons.
const FLOW_HELP = (
    <>
        <strong>Extractable entities</strong>: how each source becomes the federated directory.
        Every source record fans out into typed <em>entities</em> (middle column), and each entity
        feeds one shared <em>target schema</em> on the right. Entity names come from the
        configuration, where each is labelled the way its source names it. It's the entity-level
        view of the pipeline — a coarser companion to the field-level <strong>Map</strong>.
        Filtering to a single source makes it easiest to read. Switch to
        <strong> Target entity relationships</strong> for how the entities relate.
    </>
)
const LINKS_HELP = (
    <>
        <strong>Target entity relationships</strong>: how the resulting entity types relate to one
        another. Each coloured arrow is a declared relationship, labelled with its kind, pointing
        from one target schema to another. These are declared in the config and hold across all
        sources, so this is the shared output data model. Switch to
        <strong> Extractable entities</strong> for where each entity comes from.
    </>
)

function ModeSwitch({ mode, onChange }) {
    return (
        <div style={{ display: "inline-flex", border: "1px solid #aaa", borderRadius: 4, overflow: "hidden" }}>
            {MODES.map((m) => (
                <button key={m.key} onClick={() => onChange(m.key)} style={{
                    padding: "0.25rem 0.75rem", border: "none", cursor: "pointer", fontSize: 13,
                    background: mode === m.key ? "#4a5568" : "white", color: mode === m.key ? "#fff" : "#333",
                }}>{m.label}</button>
            ))}
        </div>
    )
}

export default function EntitiesGraph() {
    const [visible, setVisible] = useSourceParam(SOURCES)
    const [searchParams, setSearchParams] = useSearchParams()
    const mode = searchParams.get("view") === "links" ? "links" : "flow"
    const setMode = (v) => setSearchParams((prev) => {
        const p = new URLSearchParams(prev)
        v === "flow" ? p.delete("view") : p.set("view", v)
        return p
    }, { replace: true })

    const hiddenSources = useMemo(() => new Set(SOURCES.filter((s) => !visible.has(s.iri)).map((s) => s.iri)), [visible])

    const flow = useMemo(() => mode === "flow" ? loadEntities(ttl, { hiddenSources }) : null, [mode, hiddenSources])
    const links = useMemo(() => {
        if (mode !== "links") return null
        const { nodes, edges, columns, nodeY } = loadEntityLinks(ttl, { hiddenSources })
        const colors = Object.fromEntries(columns.map((c) => [c, SCHEMA_FILL]))
        const decorated = edges.map((e) => ({ ...e, value: e.relType, stroke: relColor(e.relType), valueBg: relBg(e.relType) }))
        return { nodes, edges: decorated, columns, colors, nodeY }
    }, [mode, hiddenSources])

    // Remount when mode or the visible source set changes so the layout re-fits.
    const graphKey = useMemo(() => `${mode}::${[...visible].sort().join("|")}`, [mode, visible])

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "1.25rem", padding: "0.5rem 1rem", fontSize: 13, borderBottom: "1px solid #ddd" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                    <ModeSwitch mode={mode} onChange={setMode} />
                    <InfoTip>{mode === "flow" ? FLOW_HELP : LINKS_HELP}</InfoTip>
                </span>
                <CheckboxDropdown options={SOURCE_OPTS} selected={visible} onChange={setVisible} noun="source" />
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                {mode === "flow"
                    ? <ColumnGraph key={graphKey} nodes={flow.nodes} edges={flow.edges} columns={FLOW_COLUMNS} colors={FLOW_COLORS} anchorColumns={["Source"]} colSpacing={COL_SPACING} columnTitles={FLOW_TITLES} />
                    : <ColumnGraph key={graphKey} nodes={links.nodes} edges={links.edges} columns={links.columns} colors={links.colors} colSpacing={COL_SPACING} nodeY={links.nodeY} />}
            </div>
        </div>
    )
}
