// Merge view: every org with its per-source field values and conflict
// highlighting; each org's services are nested (indented) beneath it.
// Reads:  mergedOrgs from mergeOrgs.js (← data/pipeline/merged.ttl + provenance.ttl)
// Does:   renders the Merge page (compact / wide <OrgCard>, toggleable)

import OrgCard from "./OrgCard.jsx"
import { mergedOrgs } from "./mergeOrgs.js"
import React, { useState } from "react"

const SCHEMA_SERVICE = "schema:Service"
const PROVIDER = "http://schema.org/provider"
const providerOf = (e) => e.fields.find((f) => f.predicate === PROVIDER)?.values[0]?.raw

// Top-level orgs keep their existing (conflict-sorted) order; services are
// grouped under their provider org. Any service whose provider isn't a merged
// org falls through as an orphan, rendered at the end.
const orgs = mergedOrgs.filter((e) => e.type !== SCHEMA_SERVICE)
const orgIris = new Set(orgs.map((o) => o.iri))
const servicesByOrg = new Map()
const orphanServices = []
for (const e of mergedOrgs) {
    if (e.type !== SCHEMA_SERVICE) continue
    const provider = providerOf(e)
    if (provider && orgIris.has(provider)) {
        if (!servicesByOrg.has(provider)) servicesByOrg.set(provider, [])
        servicesByOrg.get(provider).push(e)
    } else {
        orphanServices.push(e)
    }
}

export default function MergeTables() {
    const [compact, setCompact] = useState(true)
    const [highlight, setHighlight] = useState(true)
    const service = (svc) => (
        <div key={svc.iri} style={{ marginLeft: "1.5rem", borderLeft: "2px solid #e0e0e0", paddingLeft: "0.75rem" }}>
            <OrgCard org={svc} compact={compact} highlight={highlight} />
        </div>
    )
    return (
        <div className="page" style={{ overflowY: "auto", height: "100%" }}>
            <div style={{ display: "flex", gap: "1rem", marginBottom: "0.75rem", fontSize: 13 }}>
                <label style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                    <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />
                    Compact view
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                    <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} />
                    Highlight conflicts
                </label>
            </div>
            {orgs.map((org) => (
                <React.Fragment key={org.iri}>
                    <OrgCard org={org} compact={compact} highlight={highlight} />
                    {(servicesByOrg.get(org.iri) ?? []).map(service)}
                </React.Fragment>
            ))}
            {orphanServices.map(service)}
        </div>
    )
}
