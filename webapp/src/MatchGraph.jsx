// Match view: one lane per target schema, each preceded by a tinted "source
// duplications" column (which source records merged onto the entity), plus the
// cross-lane :hasRelationship edges between merged entities. All structure — lanes,
// order, colours, titles, relationships — is derived from federation.ttl inside
// loadMatch.js; this file only adds node text labels, the stats line and the modal.
// Reads:  data/pipeline/{matches,merged,mapped}.ttl, config/{federation,match-knowledge}.ttl
// Does:   renders the Match page (<ColumnGraph> + per-cluster details modal)

import { displayPrefixes, federationTtl, matchKnowledgeTtl, mappedTtl, matchesTtl, mergedTtl } from "./instanceData.js"
import { loadSourceMeta, loadSourceOfRecord } from "./sourceMeta.js"
import { CDP, groupBySubject, parseTtl, shrink } from "@directory-builder/core/utils"
import React, { useMemo, useState } from "react"
import ColumnGraph from "./ColumnGraph.jsx"
import { loadMatch } from "./loadMatch.js"

const SCHEMA_IDENTIFIER = "http://schema.org/identifier"
const CDF_NS = "https://civic-data.de/federated-directory#"
const HARD_CRITERION = `${CDP}hasHardCriterion`
const WEIGHTED_CRITERION = `${CDP}hasWeightedCriterion`
const ON = `${CDP}on`
const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs"
const OWL_DIFFERENT_FROM = "http://www.w3.org/2002/07/owl#differentFrom"

const prefixed = (iri) => shrink(iri, displayPrefixes)

// Label each source member with its :Source notation, resolved via cdp:fromSource.
const sourceMeta = loadSourceMeta(federationTtl)
const sourceOfRecord = loadSourceOfRecord(mappedTtl)
const sourceCode = (iri) => { const s = sourceOfRecord.get(iri); return (s && sourceMeta.get(s)?.notation) || "?" }
const sourceLabel = (iri) => { const s = sourceOfRecord.get(iri); return (s && sourceMeta.get(s)?.label) || sourceCode(iri) }

const criteriaPredicates = (() => {
    const quads = parseTtl(federationTtl)
    const bnodes = new Set()
    for (const q of quads) if (q.predicate.value === HARD_CRITERION || q.predicate.value === WEIGHTED_CRITERION) bnodes.add(q.object.value)
    return quads.filter(q => q.predicate.value === ON && bnodes.has(q.subject.value)).map(q => q.object.value)
})()

// Map<recordIri, Map<predIri, [literalValue]>> for the per-member details modal.
const entityInfo = groupBySubject(parseTtl(mappedTtl), { literalsOnly: true })

const manualPairs = parseTtl(matchKnowledgeTtl)
    .filter(q => q.predicate.value === OWL_SAME_AS)
    .map(q => [q.subject.value, q.object.value])

const distinctPairs = parseTtl(matchKnowledgeTtl)
    .filter(q => q.predicate.value === OWL_DIFFERENT_FROM)
    .map(q => [q.subject.value, q.object.value])

function MemberDetailsModal({ clusterId, memberIris, onClose }) {
    const memberSet = new Set(memberIris)
    const manualHere = manualPairs.filter(([a, b]) => memberSet.has(a) && memberSet.has(b))
    const distinctHere = distinctPairs.filter(([a, b]) => memberSet.has(a) || memberSet.has(b))
    return (
        <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 9999, display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: 60, overflowY: "auto" }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: "white", borderRadius: 6, padding: 20, minWidth: 480, maxWidth: 800, boxShadow: "0 8px 24px rgba(0,0,0,0.3)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, gap: 12 }}>
                    <h3 style={{ margin: 0, fontSize: 14 }}>Cluster <code>{clusterId.startsWith(CDF_NS) ? `cdf:${clusterId.slice(CDF_NS.length)}` : prefixed(clusterId)}</code></h3>
                    <button onClick={onClose} style={{ border: 0, background: "transparent", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>×</button>
                </div>
                {memberIris.map((iri) => {
                    const info = entityInfo.get(iri)
                    return (
                        <div key={iri} style={{ marginBottom: 14 }}>
                            <div style={{ fontSize: 11, color: "#666", marginBottom: 4 }}><code>{prefixed(iri)}</code></div>
                            <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                                <tbody>
                                    {criteriaPredicates.map((p) => (
                                        <tr key={p}>
                                            <td style={{ padding: "2px 8px", color: "#555", whiteSpace: "nowrap", verticalAlign: "top", width: 1 }}>{prefixed(p)}</td>
                                            <td style={{ padding: "2px 8px" }}>{info?.get(p)?.[0] ?? <span style={{ color: "#bbb" }}>—</span>}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )
                })}
                {manualHere.length > 0 && (
                    <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid #ddd" }}>
                        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Manual matches</div>
                        {manualHere.map(([a, b], i) => (
                            <div key={i} style={{ fontSize: 11, color: "#555", marginBottom: 2 }}>
                                <code>{prefixed(a)}</code> <span style={{ color: "#999" }}>owl:sameAs</span> <code>{prefixed(b)}</code>
                            </div>
                        ))}
                    </div>
                )}
                {distinctHere.length > 0 && (
                    <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid #ddd" }}>
                        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Kept distinct</div>
                        {distinctHere.map(([a, b], i) => (
                            <div key={i} style={{ fontSize: 11, color: "#555", marginBottom: 2 }}>
                                <code>{prefixed(a)}</code> <span style={{ color: "#999" }}>owl:differentFrom</span> <code>{prefixed(b)}</code>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

export default function MatchGraph() {
    const [showDuplications, setShowDuplications] = useState(true)
    const [show1to1, setShow1to1] = useState(false)
    const [openCluster, setOpenCluster] = useState(null)

    const { nodes, edges, members, clusterOf, columns, colors, columnTitles, columnBands, columnHeaderStyle, nodeY } = useMemo(() => {
        const r = loadMatch(federationTtl, matchesTtl, mergedTtl, { showDuplications, show1to1 })
        const clusterOf = new Map()
        for (const [c, ms] of r.members) for (const m of ms) clusterOf.set(m, c)

        for (const n of r.nodes) {
            if (n.isCluster) n.subtitle = n.id.startsWith(CDF_NS) ? `cdf:${n.id.slice(CDF_NS.length)}` : prefixed(n.id)
            else {                                     // a source (dedup) node
                n.label = sourceLabel(n.id)             // full source name; ColumnGraph clamps to 2 lines
                n.subtitle = entityInfo.get(n.id)?.get(SCHEMA_IDENTIFIER)?.[0]
            }
        }
        // Drop columns that ended up empty (schemas with no source duplication when
        // collapsed) so they don't leave a blank tinted band.
        const columns = r.columns.filter((c) => r.nodes.some((n) => n.type === c))
        return { ...r, clusterOf, columns }
    }, [showDuplications, show1to1])

    const handleNodeClick = (_, node) => {
        if (node.id.startsWith("__")) return            // header / band decoration
        const cid = members.has(node.id) ? node.id : clusterOf.get(node.id)
        if (cid) setOpenCluster({ clusterId: cid, memberIris: members.get(cid) ?? [] })
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ display: "flex", gap: "1rem", alignItems: "center", padding: "0.5rem 1rem", fontSize: 13, borderBottom: "1px solid #ddd" }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                    <input type="checkbox" checked={showDuplications} onChange={(e) => setShowDuplications(e.target.checked)} />
                    Show duplications across sources
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", color: showDuplications ? undefined : "#bbb" }}>
                    <input type="checkbox" checked={show1to1} disabled={!showDuplications} onChange={(e) => setShow1to1(e.target.checked)} />
                    Show 1:1 clusters
                </label>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                <ColumnGraph key={`${showDuplications}-${show1to1}`} nodes={nodes} edges={edges}
                    columns={columns} colors={colors} nodeY={nodeY}
                    columnTitles={columnTitles} columnBands={columnBands} columnHeaderStyle={columnHeaderStyle}
                    nodeWidth={150} colSpacing={236} onNodeClick={handleNodeClick} />
            </div>
            {openCluster && <MemberDetailsModal clusterId={openCluster.clusterId} memberIris={openCluster.memberIris} onClose={() => setOpenCluster(null)} />}
        </div>
    )
}
