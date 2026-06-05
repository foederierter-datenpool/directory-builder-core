import { sparqlSelect, storeFromTurtles } from "@foerderfunke/sem-ops-utils"
import { CDP, enabledSources, parseTtl, PATHS, sourceName, stepJournal } from "../utils.js"
import { ensureJar, runLift } from "./steps/lift.js"
import { runFetch } from "./steps/fetch.js"
import path from "path"
import fs from "fs"

// Ingest engine: fetch + lift per source declared in the instance's
// federation.ttl. `root` is the instance directory all PATHS resolve against.
export async function ingest(root = process.cwd()) {
    const abs = (p) => path.join(root, p)
    const federationTtl = fs.readFileSync(abs(PATHS.federation), "utf8")
    const defStore = storeFromTurtles([federationTtl])

    // ---- Read the sources ------------------------------------------------
    // The step graph (fetch → lift per source) is the engine's own shape;
    // config declares only the sources and their facts. Lift params are SPARQL
    // Anything variables declared per source. Sources run in :hasSource
    // declaration order.

    const facts = new Map()
    for (const r of await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?source ?fetchUrl ?format ?paramName ?paramValue WHERE {
            :federation :hasSource ?source .
            OPTIONAL { ?source :fetchUrl ?fetchUrl }
            OPTIONAL { ?source :format   ?format   }
            OPTIONAL { ?source :hasLiftParam [ :name ?paramName ; :value ?paramValue ] }
        }`, [defStore])) {
        if (!facts.has(r.source)) facts.set(r.source, { fetchUrl: r.fetchUrl, format: r.format, params: [] })
        if (r.paramName) facts.get(r.source).params.push([r.paramName, r.paramValue])
    }
    const sources = new Map(enabledSources(parseTtl(federationTtl)).map((iri) => [iri, facts.get(iri)]))
    for (const [iri, s] of sources) {
        if (!s.format) throw new Error(`${iri} declares no :format (needed to pick the lift query)`)
    }

    const jar = await ensureJar(abs)

    // ---- Run steps ----------------------------------------------------------

    // All :hasRunParam values grouped by name, handed to every fetcher as one
    // JSON argument — each fetcher picks the parameters it needs.
    const runParams = {}
    for (const r of await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?name ?value WHERE { :federation :hasRunParam [ :name ?name ; :value ?value ] } ORDER BY ?name ?value`, [defStore])) {
        (runParams[r.name] ??= []).push(r.value)
    }
    const paramsJson = JSON.stringify(runParams)

    const runStart = new Date()
    const harvests = []
    const journal = stepJournal()
    const fetchStepOf = new Map()
    const ctx = { abs, root }

    for (const [iri, s] of sources) {
        const name = sourceName(iri)
        fetchStepOf.set(iri, await journal.step("fetch", { source: iri }, () => {
            harvests.push({ source: iri, ...runFetch(ctx, { name, fetchUrl: s.fetchUrl, paramsJson }) })
        }))
    }

    for (const [iri, s] of sources) {
        const name = sourceName(iri)
        await journal.step("lift", { source: iri, after: [fetchStepOf.get(iri)] },
            () => runLift(ctx, { jar, name, format: s.format, params: s.params }))
    }

    const dt = (s) => `"${s}"^^xsd:dateTime`
    const runId = "run" + runStart.toISOString().replace(/\D/g, "").slice(0, 14)
    const harvestPart = harvests.length
        ? ` ;\n    :harvested\n` + harvests.map((h) => {
            const local = h.source.split("#").pop()
            const committed = h.staticCommittedAt ? ` ; :staticCommittedAt ${dt(h.staticCommittedAt)}` : ""
            return `        [ :ofSource :${local} ; prov:atTime ${dt(h.time)}${committed} ]`
        }).join(" ,\n")
        : ""

    const block = `
${journal.toTurtle()}

:${runId} a :IngestRun ;
    prov:startedAtTime ${dt(runStart.toISOString())} ;
    prov:endedAtTime   ${dt(new Date().toISOString())}${harvestPart} .
`

    const prefixes = `@prefix :      <${CDP}> .
@prefix p-plan: <http://purl.org/net/p-plan#> .
@prefix prov:   <http://www.w3.org/ns/prov#> .
@prefix xsd:    <http://www.w3.org/2001/XMLSchema#> .
`
    fs.mkdirSync(path.dirname(abs(PATHS.ingestLog)), { recursive: true })
    fs.writeFileSync(abs(PATHS.ingestLog), prefixes + block)
    console.log(`log:   wrote steps + IngestRun → ${PATHS.ingestLog}`)
}
