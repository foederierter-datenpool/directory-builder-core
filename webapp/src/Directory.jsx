// Consumer-facing directory: one compact card per resolved entity, with a type filter.
// Reads:  finalEntities from mergeEntities.js (← data/pipeline/final.ttl), federation.ttl
// Does:   renders the Directory page (filtered list of compact <EntityCard>)

import EntityCard from "./EntityCard.jsx"
import CheckboxDropdown from "./CheckboxDropdown.jsx"
import { finalEntities } from "./mergeEntities.js"
import { federationTtl } from "./instanceData.js"
import { schemaOptions } from "./filters.js"
import React, { useMemo, useState } from "react"

const SCHEMA_OPTS = schemaOptions(federationTtl).map((s) => ({ key: s.type, label: s.label }))

export default function Directory() {
    const [selected, setSelected] = useState(new Set(SCHEMA_OPTS.map((s) => s.key)))
    const list = useMemo(() => finalEntities.filter((e) => selected.has(e.type)), [selected])

    return (
        <div className="page" style={{ overflowY: "auto", height: "100%" }}>
            <div style={{ marginBottom: "0.75rem" }}>
                <CheckboxDropdown options={SCHEMA_OPTS} selected={selected} onChange={setSelected} noun="type" />
            </div>
            {list.map((entity) => <EntityCard key={entity.iri} entity={entity} compact={true} highlight={false} />)}
        </div>
    )
}
