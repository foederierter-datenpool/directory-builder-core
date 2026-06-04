// Sources overview: one card per :Source (URL, format, freshness, record/field counts).
// Reads:  config/federation.ttl, data/pipeline/mapped.ttl,
//         data/ingest/ingest-log.ttl (via loadSources.js)
// Does:   renders the Sources page (list of <Card>)

import { federationTtl, mappedTtl, ingestLogTtl, repositoryUrl } from "./instanceData.js"
import Card, { KeyValueTable } from "./Card.jsx"
import { loadSources } from "./loadSources.js"
import React from "react"

const sources = loadSources(federationTtl, mappedTtl, ingestLogTtl)

// Static-file sources have no live URL; link to their committed folder in the
// instance's declared :repository (plain path when none is declared).
const REPO_TREE = repositoryUrl && `${repositoryUrl}/tree/main`

const formatTime = (iso) => iso
    ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
    : "—"

const sourceUrl = (s) => {
    if (s.fetchUrl) return <a href={s.fetchUrl} target="_blank" rel="noreferrer">{s.fetchUrl}</a>
    if (s.staticSource) return REPO_TREE
        ? <a href={`${REPO_TREE}/${s.staticSource.replace(/\/$/, "")}`} target="_blank" rel="noreferrer">static sources</a>
        : s.staticSource
    return "—"
}

// Live sources report when they were last harvested; static sources have no
// harvest, so show the commit time of when their files entered the repo
// (journaled by ingest into the log's harvest entry).
const freshnessRow = (s) => s.staticSource
    ? { key: "added",     label: "Added to repo",  value: formatTime(s.staticCommittedAt) }
    : { key: "harvested", label: "Last harvested", value: formatTime(s.lastHarvestedAt) }

export default function Sources() {
    return (
        <div className="page" style={{ overflowY: "auto", height: "100%" }}>
            {sources.map((s) => (
                <Card key={s.iri} title={s.label ?? s.iri}>
                    <KeyValueTable rows={[
                        { key: "url",       label: "URL",            value: sourceUrl(s) },
                        { key: "format",    label: "Format",         value: s.format },
                        freshnessRow(s),
                        { key: "records",   label: "Records",        value: s.records },
                        { key: "fields",    label: "Schema fields",  value: `${s.mappedFields} mapped / ${s.totalFields} total` },
                    ]} />
                </Card>
            ))}
        </div>
    )
}
