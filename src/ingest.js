import { sparqlSelect, storeFromTurtles } from "@foerderfunke/sem-ops-utils"
import { CDP, localName, objectsOf, parseTtl, PATHS, sourceName, stepJournal } from "./utils.js"
import { execSync, spawnSync } from "child_process"
import path from "path"
import fs from "fs"

const SPARQL_ANYTHING_VERSION = "v1.1.0"

const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { stdio: "inherit" })
    if (r.status !== 0) throw new Error(`Exit ${r.status}: ${cmd} ${args.join(" ")}`)
}

// The generic lift queries ship with the engine — they resolve against this
// package, not the instance root like everything else in PATHS.
const liftQueryFor = (formatIri) =>
    path.join(import.meta.dirname, "lift", `${localName(formatIri).toLowerCase()}.sparql`)

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
    const sources = new Map(objectsOf(parseTtl(federationTtl), `${CDP}hasSource`).map((iri) => [iri, facts.get(iri)]))
    for (const [iri, s] of sources) {
        if (!s.format) throw new Error(`${iri} declares no :format (needed to pick the lift query)`)
    }

    // ---- Ensure sparql-anything.jar ----------------------------------------

    const JAR = abs("tools/sparql-anything.jar")
    const VERSION_FILE = abs("tools/sparql-anything.version")
    const haveCurrentJar = fs.existsSync(JAR) && fs.existsSync(VERSION_FILE)
        && fs.readFileSync(VERSION_FILE, "utf8").trim() === SPARQL_ANYTHING_VERSION

    if (!haveCurrentJar) {
        const url = `https://github.com/SPARQL-Anything/sparql.anything/releases/download/${SPARQL_ANYTHING_VERSION}/sparql-anything-${SPARQL_ANYTHING_VERSION}.jar`
        console.log(`Downloading sparql-anything ${SPARQL_ANYTHING_VERSION}...`)
        fs.mkdirSync(path.dirname(JAR), { recursive: true })
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
        fs.writeFileSync(JAR, Buffer.from(await response.arrayBuffer()))
        fs.writeFileSync(VERSION_FILE, SPARQL_ANYTHING_VERSION)
        console.log(`Saved to ${JAR}`)
    }

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

    for (const [iri, s] of sources) {
        const name = sourceName(iri)
        fetchStepOf.set(iri, await journal.step("fetch", { source: iri }, () => {
            const outDir = PATHS.raw(name)
            // Live sources pass their :fetchUrl; static-file sources pass the
            // absolute static dir instead. The script gets whichever applies.
            const origin = s.fetchUrl ?? abs(PATHS.staticDir(name))
            console.log(`fetch  ${s.fetchUrl ?? PATHS.staticDir(name)} (params ${paramsJson}) → ${outDir}`)
            fs.mkdirSync(abs(outDir), { recursive: true })
            run("node", [abs(PATHS.fetchScript(name)), abs(outDir), origin, paramsJson])
            const harvest = { source: iri, time: new Date().toISOString() }
            // Static sources have no live harvest — record the files' git commit
            // time instead (the freshness the Sources page shows for them).
            if (!s.fetchUrl) try {
                const iso = execSync(`git log -1 --format=%cI -- "${PATHS.staticDir(name)}"`, { cwd: root, encoding: "utf8" }).trim()
                if (iso) harvest.staticCommittedAt = iso
            } catch { /* not committed yet / no git → omit */ }
            harvests.push(harvest)
        }))
    }

    for (const [iri, s] of sources) {
        const name = sourceName(iri)
        await journal.step("lift", { source: iri, after: [fetchStepOf.get(iri)] }, () => {
            // TODO: directory mode spawns one JVM per file (~1s startup each).
            // Fine at small N; revisit if a source crosses ~50 items. SPARQL Anything
            // accepts VALUES ?_location { … } in the lift query, which would let one
            // invocation handle the whole batch.
            const liftQuery = liftQueryFor(s.format)
            const liftOne = (location, outPath) => {
                const args = ["-jar", JAR, "-q", liftQuery,
                              "-v", `location=${location}`,
                              "-f", "TTL", "-o", outPath]
                for (const [pName, value] of s.params) args.push("-v", `${pName}=${value}`)
                run("java", args)
            }
            const inAbs = abs(PATHS.raw(name))
            const outAbs = abs(PATHS.lifted(name))
            const files = fs.readdirSync(inAbs).filter(f => !f.startsWith(".")).sort()
            fs.mkdirSync(outAbs, { recursive: true })
            console.log(`lift   ${PATHS.raw(name)} (${files.length} files) → ${PATHS.lifted(name)}`)
            for (const f of files) {
                const stem = path.basename(f, path.extname(f))
                liftOne(path.join(inAbs, f), path.join(outAbs, `${stem}.ttl`))
            }
        })
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
