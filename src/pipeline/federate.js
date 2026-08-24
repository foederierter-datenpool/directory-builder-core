import { newStore, parser as n3Parser, storeFromTurtles } from "@foerderfunke/sem-ops-utils"
import { CDP, enabledSources, parseTtl, PATHS, prefixes, sourceGraph, sourceName, stepIri, stepJournal, turtlePrefixBlock } from "../utils.js"
import { extractedOutputHasMappedFields } from "../validate.js"
import { COMMON_PREFIXES, writeTurtleFile } from "./write-turtle.js"
import { MAPPED_GRAPH, runMap } from "./steps/map.js"
import { runExtract } from "./steps/extract.js"
import { runPreparation } from "./steps/preparation.js"
import { runMatch } from "./steps/match.js"
import { runMerge } from "./steps/merge.js"
import { runResolve } from "./steps/resolve.js"
import { loadEnrichConfig, runEnrich } from "./steps/enrich.js"
import { runPublish } from "./steps/publish.js"
import { DataFactory } from "n3"
import path from "path"
import fs from "fs"

const df = DataFactory

// ---- Federate engine -----------------------------------------------------
// Extract per source, load, then map → match → merge → resolve, plus enrich
// when an :EnrichRule opts in (one module per step under steps/, sharing the
// ctx of store + config + path resolver). The
// step sequence is the engine's own shape; config declares only the sources,
// processed in :hasSource declaration order. Paths follow from the source
// name (PATHS), resolved against the instance `root`. Each step runs through
// the journal, which records what executed and is rendered by the webapp's
// Pipeline page. The extract steps' predecessors are the other engine's lift
// steps, referenced by their conventional stepIri.

export async function federate(root = process.cwd()) {
    const abs = (p) => path.join(root, p)
    const federationTtl = fs.readFileSync(abs(PATHS.federation), "utf8")
    // curation.ttl (curated sameAs/differentFrom pairs, value corrections) is
    // optional — no file, no curation.
    const curation = fs.existsSync(abs(PATHS.curation)) ? [fs.readFileSync(abs(PATHS.curation), "utf8")] : []
    const defStore = storeFromTurtles([federationTtl, ...curation])
    const federationQuads = parseTtl(federationTtl)
    const sources = enabledSources(federationQuads)

    const store = newStore()
    const journal = stepJournal()
    const ctx = { store, defStore, abs, quads: federationQuads }

    const extractSteps = []
    for (const src of sources) {
        extractSteps.push(await journal.step("extract", { source: src, after: [stepIri("lift", sourceName(src))] },
            () => runExtract(ctx, src)))
    }

    // Guard the freshly-extracted output before map consumes it: every field a
    // mapping reads must have survived extract, or it would map to nothing.
    const drift = extractedOutputHasMappedFields(ctx)
    if (drift.length) throw new Error(`extracted output drifted from config at ${root}:\n  ${drift.join("\n  ")}`)

    // Project extract's value-hygiene effects (matchString + derived before→after)
    // into a per-source artifact for the webapp's Prepare view.
    await runPreparation(ctx, sources)

    // Load each source's extracted TTL into its own graph — plain mechanics, not a
    // pipeline step.
    for (const src of sources) {
        const name = sourceName(src)
        console.log(`load   ${PATHS.extracted(name)} → <${sourceGraph(name)}>`)
        const graph = df.namedNode(sourceGraph(name))
        for (const quad of n3Parser.parse(fs.readFileSync(abs(PATHS.extracted(name)), "utf8"))) {
            store.addQuad(df.quad(quad.subject, quad.predicate, quad.object, graph))
        }
    }

    const mapStep = await journal.step("map", { after: extractSteps }, async () => {
        await runMap(ctx, PATHS.mappingQueries)
        const mappedQuads = store.getQuads(null, null, null, MAPPED_GRAPH)
        await writeTurtleFile(abs(PATHS.mapped), mappedQuads, { ...COMMON_PREFIXES, cdp: CDP })
        console.log(`map: wrote ${mappedQuads.length} triples → ${PATHS.mapped}`)
    })
    const matchStep   = await journal.step("match",   { after: [mapStep] },   () => runMatch(ctx, PATHS.matches, PATHS.registry, PATHS.registryHistory))
    const mergeStep   = await journal.step("merge",   { after: [matchStep] }, () => runMerge(ctx, PATHS.merged, PATHS.provenance))
    // Enrichment is opt-in: without geocoding or inheritance rules, resolve
    // writes final.ttl directly. Otherwise its output is the intermediate that
    // enrich reads.
    const enrichConfig = await loadEnrichConfig(defStore)
    const shouldEnrich = enrichConfig.geocodeClasses.length > 0
        || enrichConfig.inheritance.length > 0
    const resolveOut = shouldEnrich ? PATHS.resolved : PATHS.final
    let lastStep = await journal.step("resolve", { after: [mergeStep] }, () => runResolve(ctx, resolveOut))
    if (shouldEnrich)
        lastStep = await journal.step("enrich", { after: [lastStep] },
            () => runEnrich(ctx, enrichConfig, PATHS.resolved, PATHS.final, PATHS.provenance, PATHS.geocache))
    // Publishing is opt-in the same way: no publication.ttl → no publish step.
    if (fs.existsSync(abs(PATHS.publication)))
        await journal.step("publish", { after: [lastStep] }, () => runPublish(ctx, abs(PATHS.catalog)))

    fs.writeFileSync(abs(PATHS.federateLog), `${turtlePrefixBlock({ "": CDP, ...prefixes("p-plan") })}

${journal.toTurtle()}
`)
    console.log(`log:   wrote steps → ${PATHS.federateLog}`)
}
