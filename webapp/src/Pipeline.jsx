// Pipeline view: the fetch→lift→…→resolve step graph the engines journaled
// while running — evidence of the executed pipeline.
// Reads:  data/ingest/ingest-log.ttl, data/pipeline/federate-log.ttl,
//         config/federation.ttl (via loadPipeline.js)
// Does:   renders the Pipeline page (horizontal <ColumnGraph>) with a Source
//         lane-header per Fetch and payload labels on the edges

import { federationTtl, ingestLogTtl, federateLogTtl } from "./instanceData.js"
import { loadPipeline } from "./loadPipeline.js"
import ColumnGraph from "./ColumnGraph.jsx"
import HelpTip from "./HelpTip.jsx"
import React from "react"

const COLUMNS = ["Source", "Fetch", "Lift", "Extract", "Map", "Input", "Match", "Merge", "Resolve", "Enrich", "End"]
const CENTER_COLUMNS = ["Extract", "Map", "Input", "Match", "Merge", "Resolve", "Enrich", "End"]
const COLORS = {
    Fetch:   "#d4e7ff",
    Lift:    "#e6f3d8",
    Extract:   "#fff1a8",
    Map:     "#f4cfe0",
    Match:   "#e2d4f4",
    Merge:   "#cfe9d8",
    Resolve: "#c5e0e8",
    Enrich:  "#cfe8e6",   // the made-not-found teal: enrich adds data no source carries
}

const { nodes, edges } = loadPipeline([ingestLogTtl, federateLogTtl], federationTtl)

export default function Pipeline() {
    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ display: "flex", padding: "0.5rem 1rem", borderBottom: "1px solid #ddd" }}>
                <HelpTip title="The Pipeline view" label="About the Pipeline view">
                    <div>
                        The steps the engines actually ran, journaled as they executed. Each source
                        is <em>fetched</em> and <em>lifted</em> into RDF, then
                        {" "}<em>extract → map → match → merge → resolve</em> fold every source into the
                        final directory. Edge labels show what passed between steps;
                        {" "}<em>manual input</em> marks curated files entering from the side.
                    </div>
                    <div>
                        Each step has one concern. <strong>Extract</strong> normalises values and
                        shapes the entities (cleaning, splitting, deduplicating within a source);
                        {" "}<strong>map</strong> renames each source's fields onto the shared schema
                        vocabulary and is value-neutral; <strong>match</strong> decides which records
                        describe the same entity and <strong>merge</strong> folds them into one;
                        {" "}<strong>resolve</strong> picks each field's value; an opt-in
                        {" "}<strong>enrich</strong> step derives data after resolution,
                        such as geocoded coordinates or values inherited from a linked entity. The last
                        step writes the final directory.
                    </div>
                    <div>
                        It's a record of the last run: evidence of the pipeline, not a live process.
                    </div>
                </HelpTip>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                <ColumnGraph
                    nodes={nodes}
                    edges={edges}
                    columns={COLUMNS}
                    colors={COLORS}
                    centerColumns={CENTER_COLUMNS}
                    direction="vertical"
                    colSpacing={120}
                    siblingGap={240}
                    nodeWidth={150}
                />
            </div>
        </div>
    )
}
