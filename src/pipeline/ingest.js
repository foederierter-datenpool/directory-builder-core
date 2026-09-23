import { sparqlSelect, storeFromTurtles } from "@foerderfunke/sem-ops-utils"
import { CDP, enabledSources, parseTtl, PATHS, prefixes, sourceName, stepJournal, turtlePrefixBlock } from "../utils.js"
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

    // All :hasRunParam values of one subject, grouped by name.
    const runParamsOf = async (subject) => {
        const params = {}
        for (const r of await sparqlSelect(`
            PREFIX : <${CDP}>
            SELECT ?name ?value WHERE { ${subject} :hasRunParam [ :name ?name ; :value ?value ] } ORDER BY ?name ?value`, [defStore])) {
            (params[r.name] ??= []).push(r.value)
        }
        return params
    }

    // Run params reach each fetcher as one JSON argument, which picks the
    // parameters it needs. The federation's are the baseline; a :Source may
    // declare its own, replacing the federation's values of the same name
    // outright (not appending to them) — a param means different things per
    // source, whether it caps records or names a partition, and no single
    // federation-wide value fits sources of different sizes and shapes.
    // Names the source doesn't mention still come from the federation.
    const federationParams = await runParamsOf(":federation")

    // Sources are independent -- separate endpoints, separate raw directories,
    // separate lift invocations -- so they run as concurrent per-source chains
    // rather than as one loop of every fetch followed by one loop of every lift.
    // A source's lift starts as soon as its own fetch finishes, which is what
    // the journal has always declared; only the execution was serial.
    //
    // Bounded, because lift spawns a JVM per raw file: the limit is the number
    // of sources in flight, so it also bounds concurrent JVMs.
    const [concurrencyRow] = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?n WHERE { :federation :maxConcurrentSources ?n }`, [defStore])
    const maxConcurrent = Math.max(1, Number(concurrencyRow?.n) || 3)

    const runStart = new Date()
    const harvests = []
    const journal = stepJournal()
    const ctx = { abs, root }

    const runSource = async ([iri, s]) => {
        const name = sourceName(iri)
        const paramsJson = JSON.stringify({ ...federationParams, ...await runParamsOf(`<${iri}>`) })
        const fetchStep = await journal.step("fetch", { source: iri }, async () => {
            harvests.push({ source: iri, ...await runFetch(ctx, { name, fetchUrl: s.fetchUrl, paramsJson }) })
        })
        await journal.step("lift", { source: iri, after: [fetchStep] },
            () => runLift(ctx, { jar, name, format: s.format, params: s.params }))
    }

    // A failing source stops further sources being started, which keeps the
    // old fail-fast intent, but sources already running are allowed to finish
    // rather than being abandoned mid-fetch. The first error is rethrown once
    // everything has settled.
    const entries = [...sources]
    const errors = []
    const inFlight = new Set()
    let next = 0
    while (next < entries.length && !errors.length) {
        if (inFlight.size >= maxConcurrent) await Promise.race(inFlight)
        if (errors.length) break
        const p = runSource(entries[next++])
            .catch((e) => { errors.push(e) })
            .finally(() => inFlight.delete(p))
        inFlight.add(p)
    }
    await Promise.all(inFlight)
    if (errors.length) throw errors[0]

    // Concurrency makes completion order arbitrary, so the log is written in
    // :hasSource declaration order — an unchanged harvest must not produce a
    // reordered file and a spurious diff.
    const declared = entries.map(([iri]) => iri)
    harvests.sort((a, b) => declared.indexOf(a.source) - declared.indexOf(b.source))

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

    const header = `${turtlePrefixBlock({ "": CDP, ...prefixes("p-plan", "prov", "xsd") })}\n`
    fs.mkdirSync(path.dirname(abs(PATHS.ingestLog)), { recursive: true })
    fs.writeFileSync(abs(PATHS.ingestLog), header + block)
    console.log(`log:   wrote steps + IngestRun → ${PATHS.ingestLog}`)
}
