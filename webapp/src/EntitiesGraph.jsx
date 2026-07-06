// Entities view: how each source becomes the federated model, in three modes
// (switched at the top, remembered in the URL as ?view=flow|links|prepare):
//   "Extractable entities" (flow)  — the derivation: source record → typed
//           entities → target schema
//   "Target entity relationships" (links) — the output relationships
//           (:hasRelationship) between the resulting entities, as a
//           source-independent schema↔schema graph
//   "Cleanup" (prepare) — what the extract step changed: per entity, the raw
//           fields it split into several targets and the values it normalised,
//           plus the (otherwise invisible) match key
// The entity DIMENSION, complementing the Map view's field-level journey.
// Reads:  config/federation.ttl (via loadEntities.js) + preparation/*.ttl

import { federationTtl as ttl } from "./instanceData.js"
import { loadEntities, loadEntityLinks } from "./loadEntities.js"
import { loadPreparation } from "./loadPreparation.js"
import { loadSources } from "./loadMap.js"
import { useSourceParam } from "./useSourceParam.js"
import React, { useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import ColumnGraph from "./ColumnGraph.jsx"
import CheckboxDropdown from "./CheckboxDropdown.jsx"
import Modal from "./Modal.jsx"

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

// Each relationship's output predicate gets its own link colour (and a light
// label tint to match) so the different link kinds read apart at a glance.
const REL_COLORS = { address: "#0d9488", provider: "#d97706", parentOrganization: "#4f46e5" }
const REL_BG     = { address: "#d7f0ed", provider: "#fdebd3", parentOrganization: "#e2e0fb" }
const REL_FALLBACK = "#9333ea"
const relColor = (t) => REL_COLORS[t] ?? REL_FALLBACK
const relBg = (t) => REL_BG[t] ?? "#efe6fb"

const MODES = [
    { key: "flow", label: "Extractable entities" },
    { key: "links", label: "Target entity relationships" },
    { key: "prepare", label: "Cleanup" },
]

// One modal describes all three modes together (a per-mode tooltip made the
// reader guess what the other tabs were). Gentle, instance-agnostic copy.
const VIEW_GUIDE = [
    {
        label: "Extractable entities",
        body: (
            <>
                How each source becomes the federated directory: every source record fans out into
                typed <em>entities</em>, and each entity feeds one shared <em>target schema</em>.
                The entity-level companion to the field-level <strong>Map</strong> view; filtering
                to a single source reads easiest. Entity names come from the configuration, each
                labelled the way its source names it.
            </>
        ),
    },
    {
        label: "Target entity relationships",
        body: (
            <>
                How the resulting entity types relate to one another — each coloured arrow a
                declared relationship (labelled with its kind) from one target schema to another.
                Declared in the config and true across all sources, so it's the shared output data
                model.
            </>
        ),
    },
    {
        label: "Cleanup",
        body: (
            <>
                What the <strong>extract</strong> step changed on the way in, per entity, in two
                kinds: a <em>split</em>, where one raw field fans out into several targets (a
                Teaser into street, PLZ and city), and a <em>normalised</em> value, where a field
                is cleaned but not split (whitespace collapsed, phone reduced to digits,
                “Str.” → “Straße”). Each <em>split</em>/<em>normalised</em> tag links to the
                <code> extract.sparql</code> that does the work. Plus the <em>match key</em> — the
                normalised string the match step compares on, invisible in every other view.
            </>
        ),
    },
]

const HELP_ICON = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: "50%", border: "1px solid #bbb", background: "white", color: "#777", fontSize: 11, lineHeight: 1, cursor: "pointer", userSelect: "none", fontWeight: 700, padding: 0 }

// The ? next to the mode switch: opens a modal describing all three views at once.
function ViewsHelp() {
    const [open, setOpen] = useState(false)
    return (
        <>
            <button style={HELP_ICON} onClick={() => setOpen(true)} aria-label="About these views" title="About these views">?</button>
            {open && (
                <Modal title="The three entity views" onClose={() => setOpen(false)}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: 13, lineHeight: 1.55, color: "#444", maxWidth: 600 }}>
                        {VIEW_GUIDE.map((v) => (
                            <div key={v.label}>
                                <div style={{ fontWeight: 600, marginBottom: 3 }}>{v.label}</div>
                                <div>{v.body}</div>
                            </div>
                        ))}
                    </div>
                </Modal>
            )}
        </>
    )
}

const KEY_BADGE = { fontFamily: "monospace", fontSize: 11, background: "#eef1f4", border: "1px solid #dde2e7", borderRadius: 3, padding: "0 5px", color: "#334" }

// Word-style whitespace reveal for the before/after cells: render anomalous
// whitespace — runs of 2+, spaces at either edge, or any non-plain space (NBSP,
// tab) — as faint middle dots, so a collapse/trim diff is legible where HTML
// would otherwise show two identical-looking values. Ordinary single interior
// spaces stay literal.
const WS_MARK = { color: "#9ca3af" }
function markWhitespace(value) {
    const nodes = []
    const re = /\s+/g
    let last = 0, m, i = 0
    while ((m = re.exec(value)) !== null) {
        if (m.index > last) nodes.push(value.slice(last, m.index))
        const run = m[0]
        const atEdge = m.index === 0 || re.lastIndex === value.length
        if (run === " " && !atEdge) nodes.push(" ")
        else nodes.push(<span key={i++} style={WS_MARK}>{"·".repeat(run.length)}</span>)
        last = re.lastIndex
    }
    if (last < value.length) nodes.push(value.slice(last))
    return nodes
}

const TAG = { fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "#9aa1ab", whiteSpace: "nowrap" }
const TAG_LINK = { color: "#6b7a99", cursor: "pointer", textDecoration: "none" }   // when it links to the query
const RAW = { color: "#9a3412" }     // before / raw value
const CLEAN = { color: "#166534" }   // after / cleaned value

// The split/normalised tag, linked to the extract.sparql that did the work when
// the instance declares a repo (both kinds live in that one file — we can't pin
// the exact rule/lines, since the config doesn't map fields to query lines).
function Tag({ kind, href, style }) {
    const s = { ...TAG, ...style }
    return href
        ? <a href={href} target="_blank" rel="noreferrer" title="Open the extract.sparql that does this on GitHub" style={{ ...s, ...TAG_LINK }}>{kind}</a>
        : <span style={s}>{kind}</span>
}

// Prepare mode: a scrollable, per-source list of entities, each showing what
// extract changed — in two visually distinct kinds:
//   split      — one raw field fanned out into ≥2 target fields (a Teaser into
//                street/PLZ/city, a "PLZ city" into two). Shown as one
//                representative raw value → an indented list of the fields it
//                produced; a "+N more" notes extra source records that dedup onto
//                the same entity (a matching detail, not extra cleaning).
//   normalised — a value changed but not split: the same field cleaned in place
//                (phone digits, whitespace) or a 1→1 derivation onto a renamed
//                field (a "strasse" span → streetAddress). Shown as before → after.
function PrepareView({ data }) {
    if (!data.length) return (
        <div style={{ padding: "1.25rem", color: "#888", fontSize: 13 }}>
            No preparation data yet — run the pipeline to generate <code>data/pipeline/preparation/</code>.
        </div>
    )
    return (
        <div style={{ height: "100%", overflow: "auto", padding: "0.75rem 1.25rem" }}>
            {data.map((src) => (
                <section key={src.iri} style={{ marginBottom: "1.5rem" }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 0.6rem" }}>
                        {src.label} <span style={{ color: "#aaa", fontWeight: 400 }}>· {src.entities.length}</span>
                    </h3>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                        {src.entities.map((e) => <EntityCard key={e.iri} entity={e} queryHref={src.queryHref} />)}
                    </div>
                </section>
            ))}
        </div>
    )
}

// Group parsed diffs by their raw origin, then collapse origins that produced an
// identical set of target fields into one block; the extra origins (duplicate
// source records) surface only as the block's "+N more" count.
function parsedGroups(parsed) {
    const byOrigin = new Map()
    for (const d of parsed) (byOrigin.get(d.before) ?? byOrigin.set(d.before, []).get(d.before)).push(d)
    const bySig = new Map()
    for (const [origin, outs] of byOrigin) {
        const sig = outs.map((o) => `${o.field}=${o.after}`).sort().join("|")
        const g = bySig.get(sig) ?? bySig.set(sig, { outs, origins: [] }).get(sig)
        g.origins.push(origin)
    }
    return [...bySig.values()]
}

function EntityCard({ entity, queryHref }) {
    const groups = parsedGroups(entity.diffs.filter((d) => d.parsed))
    // A split is one raw field fanning into ≥2 target fields. A derivation into a
    // single field is just a value normalisation onto a renamed field, so it joins
    // the in-place normalisations as a before→after row.
    const splits = groups.filter((g) => g.outs.length > 1)
    const renamed = groups.filter((g) => g.outs.length === 1)
        .flatMap((g) => g.origins.map((o) => ({ field: g.outs[0].field, before: o, after: g.outs[0].after })))
        .filter((d) => d.before !== d.after)
    const normalised = [...renamed, ...entity.diffs.filter((d) => !d.parsed)]
    const hasBody = splits.length || normalised.length
    return (
        <div style={{ border: "1px solid #eee", borderRadius: 6, padding: "0.45rem 0.7rem" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", marginBottom: hasBody ? 6 : 0 }}>
                <code style={{ fontSize: 11, color: "#667" }}>{entity.label}</code>
                {entity.matchString && <span style={{ fontSize: 11, color: "#999" }}>match key <span style={KEY_BADGE}>{entity.matchString}</span></span>}
            </div>
            {normalised.length > 0 && (
                <table style={{ borderCollapse: "collapse", fontSize: 12, marginBottom: splits.length ? 6 : 0 }}>
                    <tbody>
                        {normalised.map((d, i) => (
                            <tr key={"n" + i}>
                                <td style={{ padding: "1px 10px 1px 0", verticalAlign: "top" }}><Tag kind="normalised" href={queryHref} /></td>
                                <td style={{ color: "#8893a0", padding: "1px 12px 1px 0", whiteSpace: "nowrap", verticalAlign: "top" }}>{d.field}</td>
                                <td style={{ ...RAW, padding: "1px 8px 1px 0" }}>{markWhitespace(d.before)}</td>
                                <td style={{ color: "#c9c9c9", padding: "1px 4px", verticalAlign: "top" }}>→</td>
                                <td style={{ ...CLEAN, padding: "1px 8px" }}>{markWhitespace(d.after)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {splits.map((g, i) => (
                <div key={"s" + i} style={{ display: "flex", gap: 10, marginBottom: 6, fontSize: 12 }}>
                    <Tag kind="split" href={queryHref} style={{ paddingTop: 1 }} />
                    <div>
                        {/* One representative raw — extra origins are duplicate source
                            records (a matching concern), not extra cleaning; a muted
                            count keeps the dedup visible without repeating near-identical lines. */}
                        <div style={RAW}>
                            {markWhitespace(g.origins[0])}
                            {g.origins.length > 1 && <span style={{ color: "#b0b7c0", fontStyle: "italic" }}> · +{g.origins.length - 1} more</span>}
                        </div>
                        <table style={{ borderCollapse: "collapse", marginTop: 1 }}>
                            <tbody>
                                {g.outs.map((d, j) => (
                                    <tr key={j}>
                                        <td style={{ color: "#c9c9c9", padding: "1px 6px 1px 0", verticalAlign: "top" }}>→</td>
                                        <td style={{ color: "#8893a0", padding: "1px 12px 1px 0", whiteSpace: "nowrap", verticalAlign: "top" }}>{d.field}</td>
                                        <td style={{ ...CLEAN, padding: "1px 0" }}>{markWhitespace(d.after)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ))}
        </div>
    )
}

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
    const mode = view === "links" || view === "prepare" ? view : "flow"
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
    const prep = useMemo(() => mode === "prepare" ? loadPreparation(ttl, { hiddenSources }) : null, [mode, hiddenSources])

    // Remount when mode or the visible source set changes so the layout re-fits.
    const graphKey = useMemo(() => `${mode}::${[...visible].sort().join("|")}`, [mode, visible])

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "1.25rem", padding: "0.5rem 1rem", fontSize: 13, borderBottom: "1px solid #ddd" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                    <ModeSwitch mode={mode} onChange={setMode} />
                    <ViewsHelp />
                </span>
                <CheckboxDropdown options={SOURCE_OPTS} selected={visible} onChange={setVisible} noun="source" />
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                {mode === "prepare"
                    ? <PrepareView data={prep} />
                    : mode === "flow"
                        ? <ColumnGraph key={graphKey} nodes={flow.nodes} edges={flow.edges} columns={FLOW_COLUMNS} colors={FLOW_COLORS} anchorColumns={["Source"]} colSpacing={COL_SPACING} columnTitles={FLOW_TITLES} />
                        : <ColumnGraph key={graphKey} nodes={links.nodes} edges={links.edges} columns={links.columns} colors={links.colors} colSpacing={COL_SPACING} nodeY={links.nodeY} />}
            </div>
        </div>
    )
}
