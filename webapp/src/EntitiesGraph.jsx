// Entities view: how each source becomes the federated model, in two modes
// (switched at the top, remembered in the URL as ?view=flow|links):
//   "Entity extraction" (flow)  — the derivation: source record → typed
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
import HelpTip from "./HelpTip.jsx"

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
// The target-schema column has few nodes, so give it its own generous vertical
// gap (via columnGap) to spread them out; orderColumns puts it in crossing-
// minimising order and it renders as a block centred against the taller entity
// column, which keeps the default compact spacing.
const FLOW_TARGET_GAP = 160

// Each relationship's output predicate gets its own link colour (and a light
// label tint to match) so the different link kinds read apart at a glance.
const REL_COLORS = { address: "#0d9488", provider: "#d97706", parentOrganization: "#4f46e5" }
const REL_BG     = { address: "#d7f0ed", provider: "#fdebd3", parentOrganization: "#e2e0fb" }
const REL_FALLBACK = "#9333ea"
const relColor = (t) => REL_COLORS[t] ?? REL_FALLBACK
const relBg = (t) => REL_BG[t] ?? "#efe6fb"

const MODES = [
    { key: "flow", label: "Entity extraction" },
    { key: "links", label: "Target entity relationships" },
]

// One modal describes both modes together.
const VIEW_GUIDE = [
    {
        label: "Entity extraction",
        body: (
            <>
                How each source becomes the federated directory: every source record fans out into
                typed <em>entities</em>, and each entity feeds one shared <em>target schema</em>.
                The entity-level companion to the field-level <strong>Map</strong> view; select one
                source for the clearest graph. Each entity is labelled the way its source names it.
            </>
        ),
    },
    {
        label: "Target entity relationships",
        body: (
            <>
                How the resulting entity types relate to one another: each coloured arrow a
                declared relationship (labelled with its kind) from one target schema to another.
                Declared in the config and the same across all sources, so it's the shared output
                data model.
            </>
        ),
    },
]

// The ? next to the mode switch opens a modal describing both views.
function ViewsHelp() {
    return (
        <HelpTip title="The two entity views" label="About these views">
            {VIEW_GUIDE.map((v) => (
                <div key={v.label}>
                    <div style={{ fontWeight: 600, marginBottom: 3 }}>{v.label}</div>
                    <div>{v.body}</div>
                </div>
            ))}
            <div>
                Recorded cleanup changes (before → after values) and match keys are available
                as per-source Turtle files in{" "}
                <a href={`${import.meta.env.BASE_URL}data/pipeline/preparation/`} target="_blank" rel="noreferrer">
                    <code>data/pipeline/preparation/</code>
                </a>.
            </div>
        </HelpTip>
    )
}

// Why a mode has nothing to draw. Each mode reads a different part of the
// config, so an instance can legitimately fill one and leave another empty.
const Empty = ({ children }) => (
    <div style={{ padding: "1.25rem", color: "#888", fontSize: 13, maxWidth: "42rem", lineHeight: 1.5 }}>{children}</div>
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
    const view = searchParams.get("view")
    const mode = view === "links" ? view : "flow"
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
                    <ViewsHelp />
                    <ModeSwitch mode={mode} onChange={setMode} />
                </span>
                <CheckboxDropdown options={SOURCE_OPTS} selected={visible} onChange={setVisible} noun="source" />
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                {mode === "flow"
                    ? <ColumnGraph key={graphKey} nodes={flow.nodes} edges={flow.edges} columns={FLOW_COLUMNS} colors={FLOW_COLORS} anchorColumns={["Source"]} orderColumns={["TargetSchema"]} colSpacing={COL_SPACING} columnGap={{ TargetSchema: FLOW_TARGET_GAP }} columnTitles={FLOW_TITLES} />
                    : links.nodes.length
                        ? <ColumnGraph key={graphKey} nodes={links.nodes} edges={links.edges} columns={links.columns} colors={links.colors} colSpacing={COL_SPACING} nodeY={links.nodeY} />
                        : <Empty>No relationships between target schemas. A source declares them with <code>:hasRelationship</code>, which links one target schema to another (an organisation to its address, say).</Empty>}
            </div>
        </div>
    )
}
