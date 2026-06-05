// Consumer-facing directory: one compact card per resolved entity.
// Reads:  finalEntities from mergeEntities.js (← data/pipeline/final.ttl)
// Does:   renders the Directory page (list of compact <EntityCard>)

import EntityCard from "./EntityCard.jsx"
import { finalEntities } from "./mergeEntities.js"
import React from "react"

export default function Directory() {
    return (
        <div className="page" style={{ overflowY: "auto", height: "100%" }}>
            {finalEntities.map((entity) => <EntityCard key={entity.iri} entity={entity} compact={true} highlight={false} />)}
        </div>
    )
}
