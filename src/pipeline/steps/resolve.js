import { sparqlSelect } from "@foerderfunke/sem-ops-utils"
import { COMMON_PREFIXES, writeTurtleFile } from "../write-turtle.js"
import { MERGED_GRAPH } from "./merge.js"
import { CDP } from "../../utils.js"
import { DataFactory } from "n3"

const df = DataFactory

// One value per (subject, predicate). schema:identifier and cdp:fromSource
// are dropped — final.ttl is the consumer-facing artifact, source attribution
// lives in provenance.ttl.
const STRATEGIES = {
    alphabeticFirst: (quads) => [...quads].sort((a, b) => a.object.value.localeCompare(b.object.value))[0],
    concatenateAll:  (quads) => df.quad(quads[0].subject, quads[0].predicate,
        df.literal([...new Set(quads.map(q => q.object.value))].sort().join(", "))),
}
const RESOLVE_EXCLUDE = new Set(["http://schema.org/identifier", `${CDP}fromSource`])

const lookupStrategy = (iri) => {
    const fn = STRATEGIES[iri.split("#").pop()]
    if (!fn) throw new Error(`Unknown resolve strategy ${iri}`)
    return fn
}

export const runResolve = async ({ store, defStore, abs }, outPath) => {
    const [cfg] = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?strategy ?ns WHERE {
            ?match a :MatchRule ; :targetNamespace ?ns .
            OPTIONAL { ?resolve a :ResolveRule ; :defaultStrategy ?strategy }
        }`, [defStore])
    if (!cfg) throw new Error(":MatchRule config missing in federation.ttl")
    // No :ResolveRule (or none with a :defaultStrategy) → alphabeticFirst.
    const defaultPick = lookupStrategy(cfg.strategy ?? `${CDP}alphabeticFirst`)

    const overrideRows = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?on ?strategy WHERE {
            ?resolve a :ResolveRule ; :hasOverride [ :on ?on ; :strategy ?strategy ] .
        }`, [defStore])
    const overrides = new Map(overrideRows.map(r => [r.on, lookupStrategy(r.strategy)]))

    const groups = new Map()
    for (const q of store.getQuads(null, null, null, MERGED_GRAPH)) {
        if (RESOLVE_EXCLUDE.has(q.predicate.value)) continue
        const k = `${q.subject.value}\t${q.predicate.value}`
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(q)
    }
    const finalQuads = [...groups.values()].map(quads =>
        (overrides.get(quads[0].predicate.value) ?? defaultPick)(quads))

    await writeTurtleFile(abs(outPath), finalQuads, { ...COMMON_PREFIXES, cdf: cfg.ns })
    console.log(`resolve: wrote ${finalQuads.length} triples → ${outPath}`)
}
