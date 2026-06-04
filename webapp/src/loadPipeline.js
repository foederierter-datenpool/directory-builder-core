// Helper for the Pipeline view: turn the engines' step journals into a graph.
// Reads:  the step-journal TTL strings (ingest-log.ttl + federate-log.ttl —
//         evidence of what actually ran) and the federation TTL, passed by
//         Pipeline.jsx
// Does:   returns { nodes, edges } — Source lane-header nodes (transparent
//         fill, light-gray border) above each Fetch step, step nodes labelled
//         by their type (fetch/lift/clean/map/match/merge/resolve), and an
//         End sink so resolve's output is shown on a visible edge, plus a
//         boundary node feeding the Match step with the conventional
//         match-knowledge file. Edge labels come from federation.ttl —
//         a source's :format (uppercased) and :retrieval — or from the
//         conventions: Lift emits Turtle (LIFTED_FORMAT), other steps their
//         output file(s) per PATHS, resolved per source for Clean steps.
//         Multiple outputs (merge's provenance) stack as newlines.

import { CDP as NS, formatFamily, LIFTED_FORMAT, localName, parseTtl, PATHS, sourceName } from "@directory-builder/core/utils"

const PPLAN_STEP = "http://purl.org/net/p-plan#Step"
const PPLAN_IS_PRECEDED_BY = "http://purl.org/net/p-plan#isPrecededBy"
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
const FROM_SOURCE = `${NS}fromSource`
const RETRIEVAL = `${NS}retrieval`
const FORMAT = `${NS}format`
const LANE_BORDER = "#bbb"

const basename = (path) => path.replace(/^.*\//, "")

// Output file(s) per step type, by the PATHS conventions (name = source name).
const STEP_OUTPUTS = {
    Clean:   (name) => [PATHS.cleaned(name)],
    Map:     () => [PATHS.mapped],
    Match:   () => [PATHS.matches],
    Merge:   () => [PATHS.merged, PATHS.provenance],
    Resolve: () => [PATHS.final],
}

export function loadPipeline(stepTtls, federationTtl) {
    const quads = stepTtls.flatMap((ttl) => ttl ? parseTtl(ttl) : [])
    const fedQuads = federationTtl ? parseTtl(federationTtl) : []

    // A step is whatever the journals typed p-plan:Step; its display type is
    // the co-declared pipeline-NS class (:Fetch, :Lift, …) — no fixed list.
    const isStep = new Set()
    const nsTypeOf = new Map()
    const rawEdges = []
    const sourceOfStep = new Map()
    const formatBySubject = new Map()
    const retrievalBySubject = new Map()
    for (const q of [...quads, ...fedQuads]) {
        const p = q.predicate.value
        if (p === RDF_TYPE) {
            if (q.object.value === PPLAN_STEP) isStep.add(q.subject.value)
            else if (q.object.value.startsWith(NS)) nsTypeOf.set(q.subject.value, q.object.value.slice(NS.length))
        } else if (p === PPLAN_IS_PRECEDED_BY) rawEdges.push({ from: q.object.value, to: q.subject.value })
        else if (p === FROM_SOURCE)    sourceOfStep.set(q.subject.value, q.object.value)
        else if (p === RETRIEVAL)      retrievalBySubject.set(q.subject.value, q.object.value)
        else if (p === FORMAT)         formatBySubject.set(q.subject.value, q.object.value)
    }
    const stepType = new Map([...isStep].map((iri) => [iri, nsTypeOf.get(iri)]))

    const fileLabel = (iri) => {
        const src = sourceOfStep.get(iri)
        const outs = (STEP_OUTPUTS[stepType.get(iri)] ?? (() => []))(src && sourceName(src)).map(basename)
        return outs.length ? outs.join("\n") : null
    }
    // A Fetch step emits its source's :format from federation.ttl; a Lift
    // step always emits Turtle (engine invariant, see LIFTED_FORMAT).
    const formatOf = (iri) => ({
        Fetch: formatBySubject.get(sourceOfStep.get(iri) ?? ""),
        Lift:  LIFTED_FORMAT,
    })[stepType.get(iri)]
    // Edge label = the format the step emits (its file-type IRI's short label),
    // else its conventional output file(s); nothing hardcoded per source.
    const edgeLabel = (fromIri) => {
        const fmt = formatOf(fromIri)
        return fmt ? formatFamily(fmt) : fileLabel(fromIri)
    }

    const stepEdges = rawEdges.map((e) => ({ ...e, value: edgeLabel(e.from) ?? undefined, centered: true }))

    const sourceLabel = new Map()
    for (const q of fedQuads) {
        if (q.predicate.value === RDFS_LABEL) sourceLabel.set(q.subject.value, q.object.value)
    }

    const stepNodes = [...stepType].map(([iri, type]) => ({ id: iri, label: type.toLowerCase(), type }))

    const laneNodes = []
    const laneEdges = []
    for (const [iri, type] of stepType) {
        if (type !== "Fetch") continue
        const sourceIri = sourceOfStep.get(iri)
        if (!sourceIri) continue
        const laneId = `lane:${sourceIri}`
        laneNodes.push({
            id: laneId,
            label: sourceLabel.get(sourceIri) ?? localName(sourceIri),
            type: "Source",
            color: "transparent",
            borderColor: LANE_BORDER,
        })
        laneEdges.push({ from: laneId, to: iri, value: retrievalBySubject.get(sourceIri), centered: true })
    }

    // End sink so resolve's output (final.ttl) is shown on a visible edge.
    const resolveIri = [...stepType].find(([, t]) => t === "Resolve")?.[0]
    const endNodes = []
    const endEdges = []
    if (resolveIri) {
        endNodes.push({ id: "end", label: "end", type: "End", color: "transparent", borderColor: LANE_BORDER })
        endEdges.push({ from: resolveIri, to: "end", value: edgeLabel(resolveIri) ?? undefined, centered: true })
    }

    // Side input: the Match step consumes the conventional match-knowledge
    // file — a boundary node labelled with the file basename.
    const matchIri = [...stepType].find(([, t]) => t === "Match")?.[0]
    const inputNodes = []
    const inputEdges = []
    if (matchIri) {
        const inId = `input:${PATHS.matchKnowledge}`
        inputNodes.push({ id: inId, label: "input", type: "Input", color: "transparent", borderColor: LANE_BORDER })
        inputEdges.push({ from: inId, to: matchIri, value: basename(PATHS.matchKnowledge), centered: true, sideInput: true })
    }

    return {
        nodes: [...laneNodes, ...inputNodes, ...stepNodes, ...endNodes],
        edges: [...laneEdges, ...inputEdges, ...stepEdges, ...endEdges],
    }
}
