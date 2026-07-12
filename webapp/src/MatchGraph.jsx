// Match view: one lane per target schema, each preceded by a tinted "source
// duplications" column (which source records merged onto the entity), plus the
// cross-lane :hasRelationship edges between merged entities. All structure — lanes,
// order, colours, titles, relationships — is derived from federation.ttl inside
// loadMatch.js; this file only adds node text labels, the stats line and the modal.
// Reads:  data/pipeline/{matches,merged,mapped}.ttl, config/{federation,curation}.ttl
// Does:   renders the Match page (<ColumnGraph> + per-cluster details modal)

import { displayPrefixes, federationTtl, curationTtl, mappedTtl, matchesTtl, mergedTtl } from "./instanceData.js"
import { loadSourceMeta, loadSourceOfRecord } from "./sourceMeta.js"
import { CDP, groupBySubject, parseTtl, shrink } from "@directory-builder/core/utils"
import React, { useMemo, useState } from "react"
import ColumnGraph from "./ColumnGraph.jsx"
import CheckboxDropdown from "./CheckboxDropdown.jsx"
import HelpTip from "./HelpTip.jsx"
import Modal from "./Modal.jsx"
import { loadMatch, readSchemas } from "./loadMatch.js"

const SCHEMA_IDENTIFIER = "http://schema.org/identifier"
const SCHEMA_NAME = "http://schema.org/name"
const SCHEMA_STREET = "http://schema.org/streetAddress"   // link-cell fallback for addresses (no name)
const CDF_NS = "https://civic-data.de/federated-directory#"
const HARD_CRITERION = `${CDP}hasHardCriterion`
const WEIGHTED_CRITERION = `${CDP}hasWeightedCriterion`
const ON = `${CDP}on`
const FOR_TARGET = `${CDP}forTarget`
const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs"
const OWL_DIFFERENT_FROM = "http://www.w3.org/2002/07/owl#differentFrom"

const prefixed = (iri) => shrink(iri, displayPrefixes)

// Label each source member with its :Source notation, resolved via cdp:fromSource.
const sourceMeta = loadSourceMeta(federationTtl)
const sourceOfRecord = loadSourceOfRecord(mappedTtl)
const sourceCode = (iri) => { const s = sourceOfRecord.get(iri); return (s && sourceMeta.get(s)?.notation) || "?" }
const sourceLabel = (iri) => { const s = sourceOfRecord.get(iri); return (s && sourceMeta.get(s)?.label) || sourceCode(iri) }

// Map<targetSchemaIri, [criterionPredicateIri]> — each match rule's own :on predicates,
// scoped to the schema it's :forTarget of. Match rules are per-schema (Träger vs.
// Einrichtung vs. Angebot each have their own), so a cluster's modal must only show
// its own rule's criteria — pooling every rule's fields together mislabels a Service
// as missing postalCode/streetAddress it was never supposed to have.
const criteriaByTarget = (() => {
    const quads = parseTtl(federationTtl)
    const targetOfRule = new Map()
    const ruleOfCriterion = new Map()
    for (const q of quads) {
        if (q.predicate.value === FOR_TARGET) targetOfRule.set(q.subject.value, q.object.value)
        else if (q.predicate.value === HARD_CRITERION || q.predicate.value === WEIGHTED_CRITERION) ruleOfCriterion.set(q.object.value, q.subject.value)
    }
    const byTarget = new Map()
    for (const q of quads) {
        if (q.predicate.value !== ON) continue
        const target = targetOfRule.get(ruleOfCriterion.get(q.subject.value))
        if (!target) continue
        if (!byTarget.has(target)) byTarget.set(target, [])
        byTarget.get(target).push(q.object.value)
    }
    return byTarget
})()

const allLanes = readSchemas(federationTtl).lanes
const schemaOfLane = new Map(allLanes.map((l) => [l.key, l.schema]))

const mappedQuads = parseTtl(mappedTtl)
// Map<recordIri, Map<predIri, [literalValue]>> for the per-member details modal.
const entityInfo = groupBySubject(mappedQuads, { literalsOnly: true })
// Map<recordIri, Map<predIri, targetIri>> — relationship criteria (e.g. schema:provider)
// point at another record rather than holding a literal; resolve them to that record's
// name instead of leaving the cell blank.
const relInfo = new Map()
for (const q of mappedQuads) {
    if (q.object.termType !== "NamedNode") continue
    if (!relInfo.has(q.subject.value)) relInfo.set(q.subject.value, new Map())
    relInfo.get(q.subject.value).set(q.predicate.value, q.object.value)
}
const cellValue = (iri, p) => {
    const own = entityInfo.get(iri)?.get(p)?.[0]
    if (own != null) return own
    const target = relInfo.get(iri)?.get(p)
    if (!target) return undefined
    const t = entityInfo.get(target)
    return t?.get(SCHEMA_NAME)?.[0] ?? t?.get(SCHEMA_STREET)?.[0] ?? prefixed(target)
}

const manualPairs = parseTtl(curationTtl)
    .filter(q => q.predicate.value === OWL_SAME_AS)
    .map(q => [q.subject.value, q.object.value])

const distinctPairs = parseTtl(curationTtl)
    .filter(q => q.predicate.value === OWL_DIFFERENT_FROM)
    .map(q => [q.subject.value, q.object.value])

function MemberDetailsModal({ clusterId, memberIris, type, onClose }) {
    const memberSet = new Set(memberIris)
    const manualHere = manualPairs.filter(([a, b]) => memberSet.has(a) && memberSet.has(b))
    const distinctHere = distinctPairs.filter(([a, b]) => memberSet.has(a) || memberSet.has(b))
    const criteria = criteriaByTarget.get(schemaOfLane.get(type)) ?? []
    return (
        <Modal title={<>Cluster <code>{clusterId.startsWith(CDF_NS) ? `cdf:${clusterId.slice(CDF_NS.length)}` : prefixed(clusterId)}</code></>} onClose={onClose}>
                <div style={{ fontSize: 11, color: "#999", marginBottom: 12 }}>
                    {criteria.length > 0
                        ? "Showing this schema's match criteria fields only, not the full record."
                        : "This schema's match rule declares no criteria — nothing to show per member."}
                </div>
                {memberIris.map((iri) => {
                    return (
                        <div key={iri} style={{ marginBottom: 14 }}>
                            <div style={{ fontSize: 11, color: "#666", marginBottom: 4 }}><code>{prefixed(iri)}</code></div>
                            <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                                <tbody>
                                    {criteria.map((p) => (
                                        <tr key={p}>
                                            <td style={{ padding: "2px 8px", color: "#555", whiteSpace: "nowrap", verticalAlign: "top", width: 1 }}>{prefixed(p)}</td>
                                            <td style={{ padding: "2px 8px" }}>{cellValue(iri, p) ?? <span style={{ color: "#bbb" }}>—</span>}</td>
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

    const { nodes, edges, members, clusterOf, clusterType, columns, colors, columnTitles, columnBands, columnHeaderStyle, nodeY } = useMemo(() => {
        const r = loadMatch(federationTtl, matchesTtl, mergedTtl, { showDuplications, show1to1, activeLanes })
        const clusterOf = new Map()
        for (const [c, ms] of r.members) for (const m of ms) clusterOf.set(m, c)
        const clusterType = new Map(r.nodes.filter((n) => n.isCluster).map((n) => [n.id, n.type]))

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
        return { ...r, clusterOf, clusterType, columns }
    }, [showDuplications, show1to1, activeLanes])

    const handleNodeClick = (_, node) => {
        if (node.id.startsWith("__")) return            // header / band decoration
        const cid = members.has(node.id) ? node.id : clusterOf.get(node.id)
        if (cid) setOpenCluster({ clusterId: cid, memberIris: members.get(cid) ?? [], type: clusterType.get(cid) })
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ display: "flex", gap: "1rem", alignItems: "center", padding: "0.5rem 1rem", fontSize: 13, borderBottom: "1px solid #ddd" }}>
                <HelpTip title="The Match view" label="About the Match view">
                    <div>
                        Where duplicate records become one entity. Each lane is one
                        {" "}<strong>target schema</strong>; inside it sits every entity the match
                        step formed. The tinted column before a lane shows the
                        {" "}<em>source duplications</em>: which source records collapsed onto that
                        entity.
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
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                <ColumnGraph key={`${showDuplications}-${show1to1}-${[...activeLanes].join()}`} nodes={nodes} edges={edges}
                    columns={columns} colors={colors} nodeY={nodeY}
                    columnTitles={columnTitles} columnBands={columnBands} columnHeaderStyle={columnHeaderStyle}
                    nodeWidth={150} colSpacing={236} onNodeClick={handleNodeClick} />
            </div>
            {openCluster && <MemberDetailsModal clusterId={openCluster.clusterId} memberIris={openCluster.memberIris} type={openCluster.type} onClose={() => setOpenCluster(null)} />}
        </div>
    )
}
