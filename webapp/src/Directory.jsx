// Directory filters compact metadata and loads only visible resolved cards.

import EntityCard from "./EntityCard.jsx"
import CheckboxDropdown from "./CheckboxDropdown.jsx"
import HelpTip from "./HelpTip.jsx"
import { directoryPageSize, finalEntities, loadDirectoryPage } from "./finalEntities.js"
import { federationTtl } from "./instanceData.js"
import { schemaOptions } from "./filters.js"
import { loadSourceMeta } from "./sourceMeta.js"
import { useSourceParam } from "./useSourceParam.js"
import { usePageData } from "./usePageData.js"
import React, { useEffect, useMemo, useRef, useState } from "react"

const SCHEMA_OPTS = schemaOptions(federationTtl).map((s) => ({ key: s.type, label: s.label }))
const SOURCES = [...loadSourceMeta(federationTtl).values()]
const SOURCE_OPTS = SOURCES.map((s) => ({ key: s.iri, label: s.label }))

export default function Directory() {
    const [selected, setSelected] = useState(new Set(SCHEMA_OPTS.map((s) => s.key)))
    const [visibleSources, setVisibleSources, sourceMode, setSourceMode] = useSourceParam(SOURCES)  // mode: any = union, all = overlap
    const [page, setPage] = useState(0)
    const pageRef = useRef(null)
    const list = useMemo(() => {
        const sel = visibleSources
        // any: entity any selected source fed into. all: only entities every
        // selected source fed into (their overlap) — empty selection shows nothing.
        const bySource = sourceMode === "all"
            ? (e) => sel.size > 0 && [...sel].every((s) => e.sources.includes(s))
            : (e) => e.sources.some((s) => sel.has(s))
        return finalEntities.filter((e) => selected.has(e.type) && bySource(e))
    }, [selected, visibleSources, sourceMode])
    useEffect(() => setPage(0), [selected, visibleSources, sourceMode])
    const pageCount = Math.max(1, Math.ceil(list.length / directoryPageSize))
    const currentPage = Math.min(page, pageCount - 1)
    const start = currentPage * directoryPageSize
    const end = Math.min(start + directoryPageSize, list.length)
    const visible = useMemo(() => list.slice(start, end), [list, start, end])
    const { data, error, loading, retry } = usePageData(loadDirectoryPage, visible)
    const goToPage = (next) => {
        setPage(next)
        if (pageRef.current) pageRef.current.scrollTop = 0
    }
    const pagination = <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", margin: "0.5rem 0", fontSize: 13, color: "#666" }}>
        <span>Showing {list.length ? `${start + 1}–${end}` : "0"} of {list.length} matching entities (page {currentPage + 1} of {pageCount}).</span>
        {currentPage > 0 && <button disabled={loading} onClick={() => goToPage(currentPage - 1)}>Previous</button>}
        {currentPage + 1 < pageCount && <button disabled={loading} onClick={() => goToPage(currentPage + 1)}>Next</button>}
    </div>

    return (
        <div ref={pageRef} className="page" style={{ overflowY: "auto", height: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
                <HelpTip title="The Directory" label="About the Directory">
                    <div>
                        The finished, consumer-facing directory: one card per entity, with
                        duplicates across sources already merged. Filter by type, or by which
                        sources fed into an entity, with the dropdowns.
                    </div>
                    <div>
                        This is the end product the pipeline builds. The views under
                        {" "}<strong>Show federation process</strong> (in the top bar) explain how it
                        got here.
                    </div>
                </HelpTip>
                <CheckboxDropdown options={SCHEMA_OPTS} selected={selected} onChange={setSelected} noun="type" />
                <CheckboxDropdown options={SOURCE_OPTS} selected={visibleSources} onChange={setVisibleSources} noun="source"
                    matchMode={sourceMode} onMatchMode={setSourceMode} />
            </div>
            {pagination}
            {!data && !error && <p>Loading…</p>}
            {data?.map(entity => <EntityCard key={entity.iri} entity={entity} compact={true} highlight={false} />)}
            {error && <p>{error.message}{" "}<button onClick={retry}>Retry</button></p>}
            {data && pagination}
        </div>
    )
}
