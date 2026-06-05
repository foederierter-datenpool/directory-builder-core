// Shared helpers used by both the Node engines and instance webapps (browser),
// exported as "@directory-builder/core/utils". Keep this file browser-safe —
// no `fs`, no Node-only APIs. File-IO helpers belong in their consumer.

import { Parser } from "n3"

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"

// The engine's vocabulary namespace (config, journals, cdp: in artifacts).
export const CDP = "https://civic-data.de/pipeline#"

export const localName = (iri) => iri.replace(/^.*[#/]/, "")

// ---- Path conventions ----------------------------------------------------
// All file paths follow from the source name (the :Source IRI's local name
// minus its "Source" suffix): a source's artefacts live in sources/<name>/,
// its data flows through data/ingest/ and data/pipeline/ under the same name.

export const sourceName = (sourceIri) => localName(sourceIri).replace(/Source$/, "")

export const sourceGraph = (name) => `urn:source:${name}`

// Local name of the step IRIs the engines mint when journaling their run
// (ingest-log.ttl / federate-log.ttl): ("fetch", "caritas") → "fetchCaritas".
// Shared so the journals' cross-file p-plan:isPrecededBy references line up.
export const stepIri = (type, name) => type + name[0].toUpperCase() + name.slice(1)

// Journal of executed pipeline steps, recorded as a side effect of running
// them: step() executes fn and only then keeps the entry, so a step appears
// in the journal iff it ran, and the isPrecededBy edges are the IRIs actual
// execution threaded through (cross-engine edges reference the other
// journal's IRIs via stepIri). Per-source steps mint stepIri(type, source
// name), singletons "<type>Step". toTurtle() emits the p-plan triples; the
// engine owns its file's prefix header.
export function stepJournal() {
    const steps = []
    return {
        async step(type, { source, after = [] } = {}, fn) {
            const iri = source ? stepIri(type, sourceName(source)) : `${type}Step`
            await fn()
            steps.push({ iri, type, source, after })
            return iri
        },
        toTurtle: () => steps.map((s) =>
            `:${s.iri} a :${s.type[0].toUpperCase()}${s.type.slice(1)}, p-plan:Step` +
            (s.source ? ` ; :fromSource :${localName(s.source)}` : "") +
            (s.after.length ? ` ; p-plan:isPrecededBy ${s.after.map((a) => `:${a}`).join(", ")}` : "") +
            " .").join("\n"),
    }
}

// Engine invariant, mirrored for display: the lift step always emits Turtle
// (ingest.js invokes SPARQL Anything with -f TTL).
export const LIFTED_FORMAT = "http://publications.europa.eu/resource/authority/file-type/RDF_TURTLE"

export const PATHS = {
    federation:     "config/federation.ttl",
    matchKnowledge: "config/match-knowledge.ttl",
    about:          "webapp/content/about.md",
    query:          "webapp/content/query.sparql",
    fetchScript: (name) => `sources/${name}/fetch.js`,
    exporter:    (name) => `webapp/exporters/${name}.js`,
    staticDir:   (name) => `sources/${name}/static/`,
    cleanQuery:  (name) => `sources/${name}/clean.sparql`,
    transform:   (name, t) => `sources/${name}/transform-${t}.sparql`,
    raw:         (name) => `data/ingest/raw/${name}/`,
    lifted:      (name) => `data/ingest/lifted/${name}/`,
    cleaned:     (name) => `data/pipeline/cleaned/${name}.ttl`,
    ingestLog:   "data/ingest/ingest-log.ttl",
    federateLog: "data/pipeline/federate-log.ttl",
    mappingQueries: "data/pipeline/direct-mapping-queries/",
    mapped:      "data/pipeline/mapped.ttl",
    matches:     "data/pipeline/matches.ttl",
    merged:      "data/pipeline/merged.ttl",
    provenance:  "data/pipeline/provenance.ttl",
    final:       "data/pipeline/final.ttl",
}

// Format family of a file-type IRI (EU file-type authority): the code before
// any "_", used as a short display label — .../RDF_TURTLE -> "RDF", .../JSON -> "JSON".
export const formatFamily = (iri) => localName(iri).split("_")[0]

export const parseTtl = (turtle) => new Parser().parse(turtle)

// {prefix: namespace} declared in a Turtle document's @prefix/PREFIX lines.
// Textual on purpose: n3's Parser only reports prefixes via callbacks, which
// turn parsing asynchronous — and this must stay sync (top-level module init).
export const prefixesOf = (turtle) =>
    Object.fromEntries([...turtle.matchAll(/^\s*@?prefix\s+([\w-]*):\s*<([^>]*)>/gim)].map(([, p, ns]) => [p, ns]))

// {prefix: namespace} → "PREFIX p1: <ns1>\nPREFIX p2: <ns2>"
export const buildPrefixBlock = (prefixMap) =>
    Object.entries(prefixMap).map(([p, ns]) => `PREFIX ${p}: <${ns}>`).join("\n")

// Returns the IRI shortened against the supplied {prefix: namespace} map,
// or the original IRI verbatim if no prefix matches.
export const shrink = (iri, prefixMap) => {
    for (const [p, ns] of Object.entries(prefixMap)) {
        if (iri.startsWith(ns)) return `${p}:${iri.slice(ns.length)}`
    }
    return iri
}

// Objects of every `predIri` triple, deduped, in encounter order. RDF has no
// statement order, but Turtle parse order preserves it — so the federation's
// :hasSource declaration order is meaningful and governs source ordering
// everywhere (engine runs, journals, webapp lanes/cards).
export const objectsOf = (quads, predIri) =>
    [...new Set(quads.filter((q) => q.predicate.value === predIri).map((q) => q.object.value))]

// The federation's sources minus any switched off with `:enabled false`, in
// :hasSource declaration order — the source list engines and webapp run on.
export const enabledSources = (quads) => {
    const disabled = new Set(quads.filter((q) => q.predicate.value === `${CDP}enabled` && q.object.value === "false").map((q) => q.subject.value))
    return objectsOf(quads, `${CDP}hasSource`).filter((iri) => !disabled.has(iri))
}

// Set of subjects typed `rdf:type typeIri`. Iteration order = encounter order.
export function subjectsOfType(quads, typeIri) {
    const out = new Set()
    for (const q of quads) {
        if (q.predicate.value === RDF_TYPE && q.object.value === typeIri) out.add(q.subject.value)
    }
    return out
}

// Map<subjectIri, Set<typeIri>> for every typed subject in quads.
export function typesOf(quads) {
    const out = new Map()
    for (const q of quads) {
        if (q.predicate.value !== RDF_TYPE) continue
        let set = out.get(q.subject.value)
        if (!set) { set = new Set(); out.set(q.subject.value, set) }
        set.add(q.object.value)
    }
    return out
}

// Map<subjectIri, Map<predicateIri, valueString[]>>. Values come from
// q.object.value, so literals and IRIs both render as strings. Insertion order
// of the outer Map = encounter order of subjects in quads.
export function groupBySubject(quads, { literalsOnly = false } = {}) {
    const out = new Map()
    for (const q of quads) {
        if (literalsOnly && q.object.termType !== "Literal") continue
        const s = q.subject.value
        let row = out.get(s)
        if (!row) { row = new Map(); out.set(s, row) }
        const p = q.predicate.value
        let arr = row.get(p)
        if (!arr) { arr = []; row.set(p, arr) }
        arr.push(q.object.value)
    }
    return out
}
