import { newStore, parser as n3Parser, storeFromTurtles } from "@foerderfunke/sem-ops-utils"
import { CDP, enabledSources, parseTtl, PATHS, sourceGraph, sourceName, stepIri, stepJournal } from "../utils.js"
import { COMMON_PREFIXES, writeTurtleFile } from "./write-turtle.js"
import { MAPPED_GRAPH, runMap } from "./steps/map.js"
import { runClean } from "./steps/clean.js"
import { runMatch } from "./steps/match.js"
import { runMerge } from "./steps/merge.js"
import { runResolve } from "./steps/resolve.js"
import { DataFactory } from "n3"
import path from "path"
import fs from "fs"

const df = DataFactory

// ---- Federate engine -----------------------------------------------------
// Clean per source, load, then map → match → merge → resolve (one module per
// step under steps/, sharing the ctx of store + config + path resolver). The
// step sequence is the engine's own shape; config declares only the sources,
// processed in :hasSource declaration order. Paths follow from the source
// name (PATHS), resolved against the instance `root`. Each step runs through
// the journal, which records what executed and is rendered by the webapp's
// Pipeline page. The clean steps' predecessors are the other engine's lift
// steps, referenced by their conventional stepIri.

export async function federate(root = process.cwd()) {
    const abs = (p) => path.join(root, p)
    const federationTtl = fs.readFileSync(abs(PATHS.federation), "utf8")
    // match-knowledge.ttl (curated owl:sameAs pairs) is optional — no file, no manual matches.
    const matchKnowledge = fs.existsSync(abs(PATHS.matchKnowledge)) ? [fs.readFileSync(abs(PATHS.matchKnowledge), "utf8")] : []
    const defStore = storeFromTurtles([federationTtl, ...matchKnowledge])
    const federationQuads = parseTtl(federationTtl)
    const sources = enabledSources(federationQuads)

    const store = newStore()
    const journal = stepJournal()
    const ctx = { store, defStore, abs, quads: federationQuads }

    const cleanSteps = []
    for (const src of sources) {
        cleanSteps.push(await journal.step("clean", { source: src, after: [stepIri("lift", sourceName(src))] },
            () => runClean(ctx, src)))
    }

    // Load each source's cleaned TTL into its own graph — plain mechanics, not a
    // pipeline step.
    for (const src of sources) {
        const name = sourceName(src)
        console.log(`load   ${PATHS.cleaned(name)} → <${sourceGraph(name)}>`)
        const graph = df.namedNode(sourceGraph(name))
        for (const quad of n3Parser.parse(fs.readFileSync(abs(PATHS.cleaned(name)), "utf8"))) {
            store.addQuad(df.quad(quad.subject, quad.predicate, quad.object, graph))
        }
    }

    const mapStep = await journal.step("map", { after: cleanSteps }, async () => {
        await runMap(ctx, PATHS.mappingQueries)
        const mappedQuads = store.getQuads(null, null, null, MAPPED_GRAPH)
        await writeTurtleFile(abs(PATHS.mapped), mappedQuads, { ...COMMON_PREFIXES, cdp: CDP })
        console.log(`map: wrote ${mappedQuads.length} triples → ${PATHS.mapped}`)
    })
    const matchStep   = await journal.step("match",   { after: [mapStep] },   () => runMatch(ctx, PATHS.matches))
    const mergeStep   = await journal.step("merge",   { after: [matchStep] }, () => runMerge(ctx, PATHS.merged, PATHS.provenance))
    await journal.step("resolve", { after: [mergeStep] }, () => runResolve(ctx, PATHS.final))

    fs.writeFileSync(abs(PATHS.federateLog), `@prefix :      <${CDP}> .
@prefix p-plan: <http://purl.org/net/p-plan#> .

${journal.toTurtle()}
`)
    console.log(`log:   wrote steps → ${PATHS.federateLog}`)
}
