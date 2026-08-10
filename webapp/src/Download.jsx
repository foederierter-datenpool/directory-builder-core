// Download view: the full directory in four formats, or an external-schema export.
// Reads:  config/federation.ttl, data/pipeline/final.ttl, and the exporters
//         the federation declares via :hasExporter (instance-owned modules at
//         webapp/exporters/<name>.js, dynamic-imported at runtime like config/data)
// Does:   triggers a browser download — Turtle and JSON-LD as one graph file,
//         JSON and CSV as a zip with one file per target schema, or an
//         exporter's external-schema file

import { storeFromTurtles } from "@foerderfunke/sem-ops-utils/core"
import { turtleToJsonLdObj } from "@foerderfunke/sem-ops-utils/jsonld"
import { sparqlSelect } from "@foerderfunke/sem-ops-utils/sparql"
import { CDP, groupBySubject, localName, NAMESPACES, objectsOf, parseTtl, PATHS, shrink, subjectsOfType } from "@directory-builder/core/utils"
import { displayPrefixes, federationTtl, finalTtl, provenanceTtl } from "./instanceData.js"
import { strToU8, zipSync } from "fflate"
import HelpTip from "./HelpTip.jsx"
import React, { useState } from "react"

const RDF_TYPE = `${NAMESPACES.rdf}type`
const RDFS_LABEL = `${NAMESPACES.rdfs}label`

const FINAL_QUADS = parseTtl(finalTtl)
const BY_SUBJECT = groupBySubject(FINAL_QUADS)

// The federation's target schemas in declaration order, each with its declared
// fields — the schema definitions only, no instance data.
function readTargetSchemas() {
    const quads = parseTtl(federationTtl)
    const labelOf = new Map(), classOf = new Map(), fieldsOf = new Map(), predicateOf = new Map(), multiValued = new Set()
    // :on also hangs off match-criteria bnodes, so overrides resolve in a
    // second pass scoped to the bnodes :hasOverride points at.
    const overrideNodes = [], onOf = new Map(), strategyOf = new Map()
    // Schema-to-schema links live on mappings: a :hasRelationship bnode names
    // the predicate (via :toTargetField) and the schema at the other end.
    const toTargetOf = new Map(), relPairs = [], relFieldOf = new Map(), relSchemaOf = new Map()
    for (const q of quads) {
        const p = q.predicate.value
        if      (p === RDFS_LABEL)               labelOf.set(q.subject.value, q.object.value)
        else if (p === `${CDP}targetClass`)      classOf.set(q.subject.value, q.object.value)
        else if (p === `${CDP}targetPredicate`)  predicateOf.set(q.subject.value, q.object.value)
        else if (p === `${CDP}multiValued`)      { if (q.object.value === "true") multiValued.add(q.subject.value) }
        else if (p === `${CDP}hasOverride`)      overrideNodes.push(q.object.value)
        else if (p === `${CDP}on`)               onOf.set(q.subject.value, q.object.value)
        else if (p === `${CDP}strategy`)         strategyOf.set(q.subject.value, q.object.value)
        else if (p === `${CDP}toTarget`)         toTargetOf.set(q.subject.value, q.object.value)
        else if (p === `${CDP}hasRelationship`)  relPairs.push([q.subject.value, q.object.value])
        else if (p === `${CDP}toTargetField`)    relFieldOf.set(q.subject.value, q.object.value)
        else if (p === `${CDP}toTargetSchema`)   relSchemaOf.set(q.subject.value, q.object.value)
        else if (p === `${CDP}hasTargetField`) {
            if (!fieldsOf.has(q.subject.value)) fieldsOf.set(q.subject.value, [])
            fieldsOf.get(q.subject.value).push(q.object.value)
        }
    }
    const resolveOf = new Map(overrideNodes.flatMap((n) =>
        onOf.has(n) && strategyOf.has(n) ? [[onOf.get(n), localName(strategyOf.get(n))]] : []))
    // fromSchema -> Set<"schema:provider → Beratungsstelle">, deduped across mappings
    const schemaLabel = (iri) => labelOf.get(iri) ?? localName(iri)
    const relationsOf = new Map()
    for (const [mapping, rel] of relPairs) {
        const from = toTargetOf.get(mapping), pred = predicateOf.get(relFieldOf.get(rel)), to = relSchemaOf.get(rel)
        if (!from || !pred || !to) continue
        if (!relationsOf.has(from)) relationsOf.set(from, new Set())
        relationsOf.get(from).add(`${shrink(pred, displayPrefixes)} → ${schemaLabel(to)}`)
    }
    return objectsOf(quads, `${CDP}hasTargetSchema`).map((iri) => ({
        iri,
        name: localName(iri),
        label: schemaLabel(iri),
        classIri: classOf.get(iri),
        targetClass: shrink(classOf.get(iri) ?? "", displayPrefixes),
        relations: [...(relationsOf.get(iri) ?? [])],
        fields: (fieldsOf.get(iri) ?? []).filter((f) => predicateOf.has(f)).map((f) => ({
            predicate: predicateOf.get(f),
            label: shrink(predicateOf.get(f), displayPrefixes),
            multiValued: multiValued.has(f),
            resolve: resolveOf.get(predicateOf.get(f)),
        })),
    }))
}
const TARGET_SCHEMAS = readTargetSchemas()

// A schema's slice of final.ttl: its entities (by rdf:type) and the columns
// they actually carry — declared target fields first, in declaration order,
// then whatever else the pipeline added (e.g. enrich's schema:latitude).
function schemaRows(schema) {
    const subjects = subjectsOfType(FINAL_QUADS, schema.classIri)
    const rows = [...BY_SUBJECT].filter(([s]) => subjects.has(s))
    const present = new Set(rows.flatMap(([, row]) => [...row.keys()]))
    present.delete(RDF_TYPE)
    const declared = schema.fields.map((f) => f.predicate).filter((p) => present.has(p))
    const extras = [...present].filter((p) => !declared.includes(p))
    const columns = [...declared, ...extras].map((p) => ({ predicate: p, label: shrink(p, displayPrefixes) }))
    return { rows, columns }
}

// overview.csv: the schema-level model — each schema's target class and how
// the schemas link to each other (from the mappings' :hasRelationship decls).
function buildOverviewCsv() {
    const lines = [["schema", "targetClass", "relationships"].join(",")]
    for (const s of TARGET_SCHEMAS) lines.push([s.label, s.targetClass, s.relations.join("; ")].map(csvEscape).join(","))
    return lines.join("\n") + "\n"
}

// One CSV per schema: one row per declared :TargetField, carrying everything
// federation.ttl says about it — the predicate, the multiValued flag, and any
// custom resolve strategy (:hasOverride) on its predicate.
function buildSchemaCsv(schema) {
    const lines = [["predicate", "multiValued", "resolveOverride"].join(",")]
    for (const f of schema.fields) lines.push([f.label, f.multiValued ? "true" : "", f.resolve ?? ""].map(csvEscape).join(","))
    return lines.join("\n") + "\n"
}

const SCHEMA_FORMATS = [{ value: "csv", label: "CSV (.csv)" }]

const FORMATS = [
    { value: "ttl",    label: "Turtle (.ttl)" },
    { value: "jsonld", label: "JSON-LD (.jsonld)" },
    { value: "json",   label: "JSON (.zip, one file per schema)" },
    { value: "csv",    label: "CSV (.zip, one file per schema)" },
]

const csvEscape = (v) => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v

function buildDataCsv({ rows, columns }) {
    const lines = [["iri", ...columns.map((c) => c.label)].map(csvEscape).join(",")]
    for (const [s, row] of rows) {
        lines.push([s, ...columns.map((c) => (row.get(c.predicate) ?? []).join("; "))].map(csvEscape).join(","))
    }
    return lines.join("\n") + "\n"
}

function buildDataJson({ rows, columns }) {
    return JSON.stringify(rows.map(([s, row]) => {
        const obj = { iri: s }
        for (const c of columns) {
            const vals = row.get(c.predicate)
            if (vals) obj[c.label] = vals.length === 1 ? vals[0] : vals
        }
        return obj
    }), null, 2)
}

function triggerDownload(content, mime, filename) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }))
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
}

// Exporters are instance code, not part of this app: the federation declares
// them by name (:hasExporter "x" → webapp/exporters/x.js in the instance),
// and each module exports { label, filename, mime, build }. Bare imports can't
// resolve in a runtime-loaded module, so build() receives a toolkit instead.
const TOOLKIT = { sparqlSelect, storeFromTurtles, parseTtl, localName, shrink, groupBySubject }

const EXTERNAL_TARGETS = (await Promise.all(
    objectsOf(parseTtl(federationTtl), `${CDP}hasExporter`).map(async (name) => {
        const mod = await import(/* @vite-ignore */ `${import.meta.env.BASE_URL}${PATHS.exporter(name)}`)
            .catch((e) => { console.error(`exporter ${name} failed to load`, e); return null })
        return mod && {
            value:    name,
            label:    mod.label ?? name,
            filename: mod.filename ?? `${name}.json`,
            mime:     mod.mime ?? "application/json",
            build:    () => mod.build(finalTtl, TOOLKIT),
        }
    }),
)).filter(Boolean)

export default function Download() {
    const [format, setFormat] = useState("ttl")
    const [externalTarget, setExternalTarget] = useState(EXTERNAL_TARGETS[0]?.value)
    const [schemaFormat, setSchemaFormat] = useState("csv")

    const onDownload = async () => {
        if (format === "ttl")    return triggerDownload(finalTtl, "text/turtle", "final.ttl")
        if (format === "jsonld") return triggerDownload(
            JSON.stringify(await turtleToJsonLdObj(finalTtl), null, 2), "application/ld+json", "final.jsonld")
        const build = format === "csv" ? buildDataCsv : buildDataJson
        const files = Object.fromEntries(
            TARGET_SCHEMAS.map((s) => [`${s.name}.${format}`, strToU8(build(schemaRows(s)))]))
        triggerDownload(zipSync(files), "application/zip", `final-${format}.zip`)
    }

    const onDownloadExternal = async () => {
        const target = EXTERNAL_TARGETS.find((t) => t.value === externalTarget)
        triggerDownload(await target.build(), target.mime, target.filename)
    }

    // One zip: overview.csv (classes + inter-schema links) + one CSV per schema.
    const onDownloadSchemas = () => {
        const files = {
            "overview.csv": strToU8(buildOverviewCsv()),
            ...Object.fromEntries(TARGET_SCHEMAS.map((s) => [`${s.name}.csv`, strToU8(buildSchemaCsv(s))])),
        }
        triggerDownload(zipSync(files), "application/zip", "target-schemata.zip")
    }

    return (
        <div className="page" style={{ fontSize: 14 }}>
            <div style={{ display: "flex", margin: "0 0 0.75rem" }}>
                <HelpTip title="Download" label="About downloads">
                    <div>
                        Export the directory. Turtle and JSON-LD come as one graph file;
                        JSON and CSV as a zip with one file per target schema.
                    </div>
                    <div>
                        Below, <strong>Map to other schema</strong> (shown when this directory
                        provides an exporter) rewrites the data into a different vocabulary, and
                        {" "}<strong>Target schemas</strong> downloads the schema <em>definitions</em>
                        {" "}(one file per schema plus an overview), not the data.
                    </div>
                </HelpTip>
            </div>
            <h3 style={{ margin: "0 0 0.75rem" }}>Federated directory</h3>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                    Format:
                    <select value={format} onChange={(e) => setFormat(e.target.value)}>
                        {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                </label>
                <button onClick={onDownload}>Download</button>
            </div>
            {provenanceTtl && (
                <div style={{ marginTop: "0.75rem", fontSize: 13, color: "#888" }}>
                    Also available:{" "}
                    <a href="" style={{ color: "inherit" }} onClick={(e) => {
                        e.preventDefault()
                        triggerDownload(provenanceTtl, "text/turtle", "provenance.ttl")
                    }}>provenance.ttl</a>, tracing each triple back to its source.
                </div>
            )}

            {EXTERNAL_TARGETS.length > 0 && <>
                <hr style={{ margin: "1.5rem 0", border: 0, borderTop: "1px solid #ddd" }} />

                <h3 style={{ margin: "0 0 0.75rem" }}>Map to other schema</h3>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <select value={externalTarget} onChange={(e) => setExternalTarget(e.target.value)}>
                        {EXTERNAL_TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <button onClick={onDownloadExternal}>Download</button>
                </div>
            </>}

            {TARGET_SCHEMAS.length > 0 && <>
                <hr style={{ margin: "1.5rem 0", border: 0, borderTop: "1px solid #ddd" }} />

                <h3 style={{ margin: "0 0 0.75rem" }}>Target schemas</h3>
                <div style={{ marginBottom: "0.5rem" }}>
                    The schema definitions as a zip: one CSV per schema ({TARGET_SCHEMAS.map((s) => s.label).join(", ")}),
                    plus an overview of their classes and links.
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                        Format:
                        <select value={schemaFormat} onChange={(e) => setSchemaFormat(e.target.value)}>
                            {SCHEMA_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                        </select>
                    </label>
                    <button onClick={onDownloadSchemas}>Download</button>
                </div>
            </>}
        </div>
    )
}
