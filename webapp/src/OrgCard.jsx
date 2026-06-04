// Renders one organisation as a card (narrow key/value, or wide per-source table)
// with source tags and conflict highlighting. Also exports the conflict helpers.
// Reads:  config/federation.ttl, data/ingest/ingest-log.ttl (via sourceMeta.js);
//         org objects from loadMerge.js
// Does:   renders <OrgCard>; exports EXPECTED_MULTI, isConflict (used by mergeOrgs, MergeTables)

import { federationTtl, ingestLogTtl as logTtl } from "./instanceData.js"
import Card, { KeyValueTable } from "./Card.jsx"
import { loadHarvestBySource, loadSourceMeta } from "./sourceMeta.js"
import { CDP } from "@directory-builder/core/utils"
import React, { useState } from "react"

// org.columns are one entry per contributing record (resolved in loadMerge); look
// up source display data in config (notation, label) and the harvest log (time).
const sourceMeta = loadSourceMeta(federationTtl)
const harvestBySource = loadHarvestBySource(logTtl)
const sourceCode = (iri) => sourceMeta.get(iri).notation
const tagTitle = (iri) => {
    const label = sourceMeta.get(iri).label
    const t = harvestBySource.get(iri)
    return t ? `${label}\n\nharvested ${t.slice(0, 19).replace("T", " ")}` : label
}

export const EXPECTED_MULTI = new Set(["http://schema.org/identifier", `${CDP}fromSource`])
export const isConflict = (f) => !EXPECTED_MULTI.has(f.predicate) && f.values.length > 1

const CONFLICT_LEVELS = [
    { color: "#fca5a5", width: 2, bg: "rgba(220, 38, 38, 0.08)" },
    { color: "#f87171", width: 3, bg: "rgba(220, 38, 38, 0.16)" },
    { color: "#ef4444", width: 4, bg: "rgba(220, 38, 38, 0.24)" },
    { color: "#b91c1c", width: 5, bg: "rgba(220, 38, 38, 0.32)" },
]
const conflictStyle = (n) => {
    if (n <= 1) return undefined
    const lvl = CONFLICT_LEVELS[Math.min(n - 2, CONFLICT_LEVELS.length - 1)]
    return {
        outline: `${lvl.width}px solid ${lvl.color}`,
        borderRadius: 2,
        backgroundColor: lvl.bg,
        padding: "0 4px",
        marginRight: 6,
    }
}

function SourceTags({ sources }) {
    return (
        <>
            {sources.map((iri, i) => (
                <span key={i} className="source-tag" title={tagTitle(iri)}>{sourceCode(iri)}</span>
            ))}
        </>
    )
}

function ValueCell({ values, highlight }) {
    const [idx, setIdx] = useState(0)
    // idx persists across re-renders, so clamp when `values` shrinks (e.g.
    // rendering final.ttl where every (s,p) has exactly one value).
    const safeIdx = idx % values.length
    const cur = values[safeIdx]
    const multi = values.length > 1
    const style = highlight ? conflictStyle(values.length) : undefined
    return (
        <>
            {multi && (
                <span className="flip">
                    <button className="flip-btn" onClick={() => setIdx((safeIdx - 1 + values.length) % values.length)}>◀</button>
                    <span className="flip-counter">{safeIdx + 1}/{values.length}</span>
                    <button className="flip-btn" onClick={() => setIdx((safeIdx + 1) % values.length)}>▶</button>
                </span>
            )}
            <span className="value-text" title={cur.raw ?? cur.value} style={style}>{cur.value}</span>
            <SourceTags sources={cur.sources} />
        </>
    )
}

function OrgCardNarrow({ org, highlight }) {
    return <KeyValueTable rows={org.fields.map((f) => ({ key: f.predicate, label: f.predLabel, value: <ValueCell values={f.values} highlight={highlight && isConflict(f)} /> }))} />
}

function OrgCardWide({ org, highlight }) {
    const columns = org.columns
    return (
        <table>
            <thead>
                <tr>
                    <th></th>
                    {columns.map((c) => (
                        <th key={c.record} title={tagTitle(c.source)}>
                            <span className="source-tag">{sourceCode(c.source)}</span>
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {org.fields.map((f) => {
                    const conflict = highlight && isConflict(f) ? conflictStyle(f.values.length) : undefined
                    return (
                        <tr key={f.predicate}>
                            <td>{f.predLabel}</td>
                            {columns.map((c) => {
                                const v = f.values.find((val) => val.records.includes(c.record))
                                return <td key={c.record} title={v?.raw ?? v?.value}>{v && <span className="value-text" style={{ maxWidth: "50ch", ...conflict }}>{v.value}</span>}</td>
                            })}
                        </tr>
                    )
                })}
            </tbody>
        </table>
    )
}

export default function OrgCard({ org, compact, highlight }) {
    return (
        <Card title={org.label} tag={org.type}>
            {compact ? <OrgCardNarrow org={org} highlight={highlight} /> : <OrgCardWide org={org} highlight={highlight} />}
        </Card>
    )
}
