// Match draws and lays out the visible connected groups; cluster details include their match criteria.

import { displayPrefixes, federationTtl } from "./instanceData.js"
import { loadSourceMeta } from "./sourceMeta.js"
import { NAMESPACES, shrink } from "@directory-builder/core/utils"
import React, { useEffect, useMemo, useState } from "react"
import ColumnGraph from "./ColumnGraph.jsx"
import CheckboxDropdown from "./CheckboxDropdown.jsx"
import HelpTip from "./HelpTip.jsx"
import Modal from "./Modal.jsx"
import { buildMatchGraph, matchPages } from "@directory-builder/core/match-view"
import { allLanes, criteriaByTarget, distinctPairs, loadMatchPage, manualPairs, matchData, matchPageSize } from "./matchEntities.js"
import { usePageData } from "./usePageData.js"

const CDF_NS = NAMESPACES.cdf
const FULL_VIEW_LIMIT = 500
const prefixed = iri => shrink(iri, displayPrefixes)
const sourceMeta = loadSourceMeta(federationTtl)
const schemaOfLane = new Map(allLanes.map(lane => [lane.key, lane.schema]))

function MemberDetailsModal({ cluster, onClose }) {
    const { iri: clusterId, type, records } = cluster
    const memberIris = records.map(record => record.iri)
    const memberSet = new Set(memberIris)
    const manualHere = manualPairs.filter(([a, b]) => memberSet.has(a) && memberSet.has(b))
    const distinctHere = distinctPairs.filter(([a, b]) => memberSet.has(a) || memberSet.has(b))
    const criteria = criteriaByTarget.get(schemaOfLane.get(type)) ?? []
    return (
        <Modal title={<>Cluster <code>{clusterId.startsWith(CDF_NS) ? `cdf:${clusterId.slice(CDF_NS.length)}` : prefixed(clusterId)}</code></>} onClose={onClose}>
                <div style={{ fontSize: 11, color: "#999", marginBottom: 12 }}>
                    {criteria.length > 0
                        ? "Showing this schema's match criteria fields only, not the full record."
                        : "This schema's match rule declares no criteria: nothing to show per member."}
                </div>
                {records.map(({ iri, values }) => {
                    return (
                        <div key={iri} style={{ marginBottom: 14 }}>
                            <div style={{ fontSize: 11, color: "#666", marginBottom: 4 }}><code>{prefixed(iri)}</code></div>
                            <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                                <tbody>
                                    {criteria.map((p, position) => (
                                        <tr key={p}>
                                            <td style={{ padding: "2px 8px", color: "#555", whiteSpace: "nowrap", verticalAlign: "top", width: 1 }}>{prefixed(p)}</td>
                                            <td style={{ padding: "2px 8px" }}>{values[position] ?? <span style={{ color: "#bbb" }}>—</span>}</td>
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
        </Modal>
    )
}

export default function MatchGraph() {
    const [showDuplications, setShowDuplications] = useState(true)
    const [show1to1, setShow1to1] = useState(false)
    // Which lanes are shown, seeded from config (:hiddenByDefault lanes start off).
    const [activeLanes, setActiveLanes] = useState(() => new Set(allLanes.filter((l) => !l.hidden).map((l) => l.key)))
    const [openCluster, setOpenCluster] = useState(null)
    const [page, setPage] = useState(0)
    useEffect(() => setPage(0), [showDuplications, show1to1, activeLanes])

    const full = useMemo(() => buildMatchGraph(matchData,
        { activeLanes, layoutLimit: 0 }), [activeLanes])
    const pages = useMemo(() => full.nodes.length > FULL_VIEW_LIMIT
        ? matchPages(full.nodes, full.edges, matchPageSize) : null, [full])
    const currentPage = Math.min(page, (pages?.length ?? 1) - 1)
    const visible = useMemo(() => {
        if (!pages) return full.nodes
        const ids = new Set(pages[currentPage])
        return full.nodes.filter(node => ids.has(node.id))
    }, [full, pages, currentPage])
    const { data: details, error, retry } = usePageData(loadMatchPage, visible)
    const graph = useMemo(() => {
        if (!details) return null
        const members = new Map(details.map(cluster => [cluster.iri, cluster.records.map(record => record.iri)]))
        const records = new Map(details.flatMap(cluster => cluster.records.map(record => [record.iri, record])))
        const nodes = details.map(cluster => ({ id: cluster.iri, type: cluster.type, label: cluster.label, isCluster: true }))
        const result = buildMatchGraph({ ...matchData, nodes, members }, { showDuplications, show1to1, activeLanes })
        for (const node of result.nodes) {
            if (node.isCluster) node.subtitle = node.id.startsWith(CDF_NS) ? `cdf:${node.id.slice(CDF_NS.length)}` : prefixed(node.id)
            else {
                const record = records.get(node.id)
                node.label = sourceMeta.get(record.source)?.label ?? sourceMeta.get(record.source)?.notation ?? "?"
                node.subtitle = record.identifier
            }
        }
        // Empty source columns should not leave blank tinted bands.
        result.columns = result.columns.filter(column => result.nodes.some(node => node.type === column))
        return result
    }, [details, showDuplications, show1to1, activeLanes])
    const handleNodeClick = (_, node) => {
        if (node.id.startsWith("__")) return
        const cluster = details?.find(cluster => cluster.iri === node.id || cluster.records.some(record => record.iri === node.id))
        if (cluster) setOpenCluster(cluster)
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ display: "flex", gap: "1rem", alignItems: "center", padding: "0.5rem 1rem", fontSize: 13, borderBottom: "1px solid #ddd" }}>
                <HelpTip title="The Match view" label="About the Match view">
                    <div>
                        Where duplicate records become one entity. Each lane is one
                        {" "}<strong>target schema</strong> (one entity type); inside it sits every
                        entity the match step formed, each a <em>cluster</em> of the source records
                        that matched. The tinted column to the left of a lane shows the
                        {" "}<em>source duplications</em>: which source records collapsed onto that
                        entity. Source records appear for clusters with multiple members;
                        {" "}<em>Show 1:1 clusters</em> also shows single-member source records.
                    </div>
                    <div>
                        Arrows across lanes are the declared <em>relationships</em> between
                        entities. Click any cluster to see the fields its match rule compared on.
                        Lanes, order, colours and relationships all come from the configuration.
                    </div>
                </HelpTip>
                <CheckboxDropdown options={allLanes.map((l) => ({ key: l.key, label: l.label }))}
                    selected={activeLanes} onChange={setActiveLanes} noun="lane" />
                <label style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                    <input type="checkbox" checked={showDuplications} onChange={(e) => setShowDuplications(e.target.checked)} />
                    Show duplications across sources
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", color: showDuplications ? undefined : "#bbb" }}>
                    <input type="checkbox" checked={show1to1} disabled={!showDuplications} onChange={(e) => setShow1to1(e.target.checked)} />
                    Show 1:1 clusters
                </label>
                <span style={{ color: "#666" }}>{pages
                    ? `${visible.length} of ${full.nodes.length} clusters (page ${currentPage + 1} of ${pages.length})`
                    : `${full.nodes.length} clusters`}</span>
                {pages && currentPage > 0 && <button onClick={() => setPage(currentPage - 1)}>Previous</button>}
                {pages && currentPage + 1 < pages.length && <button onClick={() => setPage(currentPage + 1)}>Next</button>}
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                {!graph && !error && <p>Loading…</p>}
                {error && <p>{error.message}{" "}<button onClick={retry}>Retry</button></p>}
                {graph && <ColumnGraph key={`${showDuplications}-${show1to1}-${[...activeLanes].join()}-${currentPage}`} {...graph}
                    nodeWidth={150} colSpacing={236} onNodeClick={handleNodeClick} />}
            </div>
            {openCluster && <MemberDetailsModal cluster={openCluster} onClose={() => setOpenCluster(null)} />}
        </div>
    )
}
