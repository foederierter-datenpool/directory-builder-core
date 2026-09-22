import { buildValidator, turtleToDataset } from "@foerderfunke/sem-ops-utils"
import { CDP, enabledSources, identifierField, NAMESPACES, objectsOf, parseTtl, PATHS, shrink, sourceName } from "./utils.js"
import path from "path"
import fs from "fs"

// The facade-x namespace lifted source fields land under: xyz:<fieldPath>.
const XYZ = NAMESPACES.xyz

const RDF_TYPE = `${NAMESPACES.rdf}type`

// Instance integrity checks. Each check takes { abs, ttl, quads } (path
// resolver rooted at the instance, federation.ttl raw + parsed) and returns
// problem strings. validate() runs them all; empty result = valid. Runs
// automatically before the engines; `directory-builder validate` triggers it
// on its own.

const checks = [sourcesFoldersInSync, federationConformsToShape, noLegacyCurationFile, catalogConformsToShape,
                hardCriteriaCoveredBySources]

export async function validate(root = process.cwd()) {
    const abs = (p) => path.join(root, p)
    if (!fs.existsSync(abs(PATHS.federation))) return [`${PATHS.federation} missing`]
    const ttl = fs.readFileSync(abs(PATHS.federation), "utf8")
    const ctx = { abs, ttl, quads: parseTtl(ttl) }
    return (await Promise.all(checks.map((check) => check(ctx)))).flat()
}

// Every :hasSource in federation.ttl has what its engine steps need: a
// fetch.js or static/ to default to, a extract.sparql or an :iriSource field to
// derive the default extract from - and no sources/ folder exists that the
// federation doesn't declare. Checks all declared sources, enabled or not:
// folder presence is a repo-layout contract. This "key OR extract.sparql" rule
// is filesystem-dependent, so it lives here, not in the SHACL shape.
function sourcesFoldersInSync({ abs, quads }) {
    const declared = objectsOf(quads, `${CDP}hasSource`)
    const problems = []
    for (const iri of declared) {
        const name = sourceName(iri)
        if (![PATHS.fetchScript(name), PATHS.staticDir(name)].some((f) => fs.existsSync(abs(f))))
            problems.push(`${PATHS.fetchScript(name)} missing and no ${PATHS.staticDir(name)} to default to`)
        if (!fs.existsSync(abs(PATHS.extractQuery(name))) && !identifierField(quads, iri))
            problems.push(`${PATHS.extractQuery(name)} missing and no :iriSource field to derive the default extract from`)
    }
    // The other direction: every folder in sources/ must be declared in federation.ttl.
    const declaredNames = declared.map(sourceName)
    const folders = fs.existsSync(abs("sources"))
        ? fs.readdirSync(abs("sources"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        : []
    for (const name of folders) {
        if (!declaredNames.includes(name)) problems.push(`sources/${name}/ has no :hasSource declaration in ${PATHS.federation}`)
    }
    return problems
}

// curation.ttl is optional, so a file left under its legacy name would silently
// stop being loaded and its curated merges/corrections would vanish — the one
// failure mode of the rename this check can catch.
function noLegacyCurationFile({ abs }) {
    return fs.existsSync(abs("config/match-knowledge.ttl"))
        ? [`config/match-knowledge.ttl is the legacy name and no longer loaded, rename it to ${PATHS.curation}`]
        : []
}

// federation.ttl conforms to the engine's config contract, expressed as SHACL
// in federation.shacl.ttl next to this file - the shape ships with the
// package, instances never carry it.
const shapeValidator = (file) => buildValidator(fs.readFileSync(path.join(import.meta.dirname, "validate", file), "utf8"))
const validator = shapeValidator("federation.shacl.ttl")

async function federationConformsToShape({ ttl }) {
    const report = await validator.validate({ dataset: turtleToDataset(ttl) })
    return report.results.map((r) =>
        `${PATHS.federation}: ${shrink(r.focusNode.value, { "": CDP })} ${r.message.map((m) => m.value).join("; ")}`)
}

// The published catalog conforms to the DCAT-AP.de constraints in
// publish.shacl.ttl. Publishing is opt-in, so no catalog.ttl (no
// publication.ttl, or never run) is not a problem.
const catalogValidator = shapeValidator("publish.shacl.ttl")

async function catalogConformsToShape({ abs }) {
    if (!fs.existsSync(abs(PATHS.catalog))) return []
    const report = await catalogValidator.validate({ dataset: turtleToDataset(fs.readFileSync(abs(PATHS.catalog), "utf8")) })
    return report.results.map((r) => `${PATHS.catalog}: ${r.focusNode.value} ${r.message.map((m) => m.value).join("; ")}`)
}

// Every source feeding a match rule's target supplies the fields the rule gates
// on. A hard criterion rejects a pair unless both sides carry the value, so a
// source that never fills the predicate stops participating in federation
// entirely — and the run still looks healthy. Same class of bug as the drift
// check (config naming a field no source supplies); match rules just weren't
// covered by it. Statically decidable from :Mapping/:hasFieldMapping, so it
// fails before a run rather than producing a quietly wrong directory.
// :optional true on the criterion opts into fall-through instead.
function hardCriteriaCoveredBySources({ quads }) {
    const o = (s, p) => quads.filter((q) => q.subject.value === s && q.predicate.value === `${CDP}${p}`).map((q) => q.object.value)
    const typed = (cls) => quads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === `${CDP}${cls}`).map((q) => q.subject.value)
    const enabled = new Set(enabledSources(quads))
    const problems = []
    for (const rule of typed("MatchRule")) {
        const target = o(rule, "forTarget")[0]
        if (!target) continue   // the shape check reports a missing :forTarget
        const mappings = quads
            .filter((q) => q.predicate.value === `${CDP}toTarget` && q.object.value === target)
            .map((q) => q.subject.value)
        for (const crit of o(rule, "hasHardCriterion")) {
            if (o(crit, "optional")[0] === "true") continue
            const pred = o(crit, "on")[0]
            if (!pred) continue
            // Engine-internal predicates (cdp:matchString, the normalised
            // matching surface) come from extract.sparql, not from a mapping —
            // nothing in the config declares them, so there is nothing to check.
            if (pred.startsWith(CDP)) continue
            for (const mapping of mappings) {
                const src = o(mapping, "fromSource")[0]
                if (!src || !enabled.has(src)) continue
                // A target field is filled either by a field mapping or, for an
                // entity link (schema:address, schema:provider), by a
                // :hasRelationship naming the same :TargetField.
                const mapped = [
                    ...o(mapping, "hasFieldMapping").flatMap((fm) => o(fm, "to")),
                    ...o(mapping, "hasRelationship").flatMap((rel) => o(rel, "toTargetField")),
                ].flatMap((tgt) => o(tgt, "targetPredicate"))
                if (!mapped.includes(pred))
                    problems.push(`${PATHS.federation}: ${shrink(rule, { "": CDP })} gates on ${shrink(pred, NAMESPACES)} as a hard criterion, but ${shrink(src, { "": CDP })} maps nothing to it — every record of that source would be unmatchable (map the field, disable the source, or declare :optional true on the criterion)`)
            }
        }
    }
    return problems
}

// Post-extract drift check (config ↔ real data): the map step reads xyz:<fieldPath>
// for every field a mapping consumes (:from), so a mapped field the extracted output
// no longer carries would map to nothing. Catches the source data or a extract.sparql
// drifting away from what the config still maps — invisible to the config-shape
// check, which only sees the config. Presence is checked file-wide (not per entity)
// so field-path reuse and sub-field nesting don't false-positive; a path entirely
// absent is the real signal. federate() runs this after extract, before map — never
// pre-ingest, where it would flag stale output the run is about to regenerate.
// Sources without a extracted file yet (not run) are skipped.
export function extractedOutputHasMappedFields({ abs, quads }) {
    const o = (s, p) => quads.filter((q) => q.subject.value === s && q.predicate.value === `${CDP}${p}`).map((q) => q.object.value)
    const problems = []
    for (const src of enabledSources(quads)) {
        const extracted = abs(PATHS.extracted(sourceName(src)))
        if (!fs.existsSync(extracted)) continue
        const present = new Set(parseTtl(fs.readFileSync(extracted, "utf8"))
            .filter((q) => q.predicate.value.startsWith(XYZ))
            .map((q) => q.predicate.value.slice(XYZ.length)))
        const mappedFields = new Set(quads
            .filter((q) => q.predicate.value === `${CDP}fromSource` && q.object.value === src)
            .flatMap((q) => o(q.subject.value, "hasFieldMapping"))
            .flatMap((fm) => o(fm, "from")))
        for (const field of mappedFields) {
            const fieldPath = o(field, "fieldPath")[0]
            if (fieldPath && !present.has(fieldPath))
                problems.push(`${PATHS.extracted(sourceName(src))}: ${shrink(field, { "": CDP })} maps :fieldPath "${fieldPath}", missing from the extracted output (source data or extract.sparql drifted)`)
        }
    }
    return problems
}
