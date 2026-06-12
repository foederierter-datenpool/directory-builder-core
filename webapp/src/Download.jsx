// Download view: choose target fields + format, or an external-schema export.
// Reads:  config/federation.ttl, data/pipeline/final.ttl, and the exporters
//         the federation declares via :hasExporter (instance-owned modules at
//         webapp/exporters/<name>.js, dynamic-imported at runtime like config/data)
// Does:   triggers a browser download (.ttl / .jsonld / .json / .csv, or an
//         exporter's external-schema file)

import { datasetToTurtleWriter, storeFromTurtles } from "@foerderfunke/sem-ops-utils/core"
import { turtleToJsonLdObj } from "@foerderfunke/sem-ops-utils/jsonld"
import { sparqlSelect } from "@foerderfunke/sem-ops-utils/sparql"
import { CDP, groupBySubject, localName, objectsOf, parseTtl, PATHS, shrink, subjectsOfType } from "@directory-builder/core/utils"
import { displayPrefixes, federationTtl, finalTtl } from "./instanceData.js"
import { strToU8, zipSync } from "fflate"
import React, { useState } from "react"

const SCHEMA_IDENTIFIER = "http://schema.org/identifier"
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label"

function readTargetFields() {
    const quads = parseTtl(federationTtl)
    const isTargetField = subjectsOfType(quads, `${CDP}TargetField`)
    const fieldOrder = []
    const seen = new Set()
    const predicateOf = new Map()
    for (const q of quads) {
        if (q.predicate.value === `${CDP}hasTargetField`) {
            if (!seen.has(q.object.value)) { seen.add(q.object.value); fieldOrder.push(q.object.value) }
        } else if (q.predicate.value === `${CDP}targetPredicate`) {
            predicateOf.set(q.subject.value, q.object.value)
        }
    }
    return fieldOrder
        .filter((iri) => isTargetField.has(iri) && predicateOf.has(iri))
        .map((iri) => ({ predicate: predicateOf.get(iri), label: shrink(predicateOf.get(iri), displayPrefixes) }))
        .filter((f) => f.predicate !== SCHEMA_IDENTIFIER)
}

const FINAL_QUADS = parseTtl(finalTtl)
// Only offer target fields that actually carry data in final.ttl —
// declared-but-unmapped fields would just download as empty columns.
const PREDICATES_WITH_DATA = new Set(FINAL_QUADS.map((q) => q.predicate.value))
const TARGET_FIELDS = readTargetFields().filter((f) => PREDICATES_WITH_DATA.has(f.predicate))

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
        targetClass: shrink(classOf.get(iri) ?? "", displayPrefixes),
        relations: [...(relationsOf.get(iri) ?? [])],
        fields: (fieldsOf.get(iri) ?? []).filter((f) => predicateOf.has(f)).map((f) => ({
            label: shrink(predicateOf.get(f), displayPrefixes),
            multiValued: multiValued.has(f),
            resolve: resolveOf.get(predicateOf.get(f)),
        })),
    }))
}
const TARGET_SCHEMAS = readTargetSchemas()

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
    { value: "ttl",    label: "Turtle (.ttl)",     ext: "ttl",    mime: "text/turtle" },
    { value: "jsonld", label: "JSON-LD (.jsonld)", ext: "jsonld", mime: "application/ld+json" },
    { value: "json",   label: "JSON (.json)",      ext: "json",   mime: "application/json" },
    { value: "csv",    label: "CSV (.csv)",        ext: "csv",    mime: "text/csv" },
]

const csvEscape = (v) => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v

function buildCsv(quads, fields) {
    const bySubject = groupBySubject(quads)
    const header = ["iri", ...fields.map((f) => f.label)]
    const lines = [header.map(csvEscape).join(",")]
    for (const [s, row] of bySubject) {
        const cells = [s, ...fields.map((f) => (row.get(f.predicate) ?? []).join("; "))]
        lines.push(cells.map(csvEscape).join(","))
    }
    return lines.join("\n") + "\n"
}

function buildJson(quads, fields) {
    const out = []
    for (const [s, row] of groupBySubject(quads)) {
        const obj = { iri: s }
        for (const f of fields) {
            const vals = row.get(f.predicate)
            if (!vals) continue
            obj[f.label] = vals.length === 1 ? vals[0] : vals
        }
        out.push(obj)
    }
    return JSON.stringify(out, null, 2)
}

async function buildFile(selectedFields, format) {
    const allowed = new Set(selectedFields.map((f) => f.predicate))
    const filtered = FINAL_QUADS.filter((q) => allowed.has(q.predicate.value))
    if (format === "csv")  return buildCsv(filtered, selectedFields)
    if (format === "json") return buildJson(filtered, selectedFields)
    const ttl = await datasetToTurtleWriter(filtered, displayPrefixes)
    if (format === "ttl") return ttl
    const jsonld = await turtleToJsonLdObj(ttl)
    return JSON.stringify(jsonld, null, 2)
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
    const [selected, setSelected] = useState(() => new Set(TARGET_FIELDS.map((f) => f.predicate)))
    const [format, setFormat] = useState("ttl")
    const [externalTarget, setExternalTarget] = useState(EXTERNAL_TARGETS[0]?.value)
    const [schemaFormat, setSchemaFormat] = useState("csv")

    const toggle = (pred) => {
        const next = new Set(selected)
        if (next.has(pred)) next.delete(pred); else next.add(pred)
        setSelected(next)
    }

    const onDownload = async () => {
        const fmt = FORMATS.find((f) => f.value === format)
        const fields = TARGET_FIELDS.filter((f) => selected.has(f.predicate))
        const content = await buildFile(fields, format)
        triggerDownload(content, fmt.mime, `final.${fmt.ext}`)
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
            <h3 style={{ margin: "0 0 0.75rem" }}>Federated directory</h3>
            <div style={{ marginBottom: "0.5rem" }}>Fields to include:</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", columnGap: "1rem", rowGap: "0.25rem" }}>
                {TARGET_FIELDS.map((f) => (
                    <label key={f.predicate} style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                        <input type="checkbox" checked={selected.has(f.predicate)} onChange={() => toggle(f.predicate)} />
                        <code>{f.label}</code>
                    </label>
                ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "1rem" }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                    Format:
                    <select value={format} onChange={(e) => setFormat(e.target.value)}>
                        {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                </label>
                <button onClick={onDownload} disabled={selected.size === 0}>Download</button>
            </div>

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
