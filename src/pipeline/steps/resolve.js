import { sparqlSelect } from "@foerderfunke/sem-ops-utils"
import { COMMON_PREFIXES, writeTurtleFile } from "../write-turtle.js"
import { HAS_MEMBER, MATCH_GRAPH } from "./match.js"
import { MERGED_GRAPH } from "./merge.js"
import { CDP, NAMESPACES } from "../../utils.js"
import { DataFactory } from "n3"

const df = DataFactory

// One value per (subject, predicate). schema:identifier and cdp:fromSource
// are dropped — directory.ttl is the consumer-facing artifact, source attribution
// lives in provenance.ttl.
// A strategy returns either one quad (collapse the group to a single value) or an
// array of quads (keep several). The caller flattens, so both forms compose.
const STRATEGIES = {
    // The default: when sources disagree, the longest literal usually carries
    // the most information (full name over an acronym, a street over a fragment).
    // Equal lengths fall back to alphabeticFirst so the pick stays deterministic.
    longestValue: (quads) => [...quads].sort((a, b) =>
        b.object.value.length - a.object.value.length || a.object.value.localeCompare(b.object.value))[0],
    alphabeticFirst: (quads) => [...quads].sort((a, b) => a.object.value.localeCompare(b.object.value))[0],
    concatenateAll:  (quads) => df.quad(quads[0].subject, quads[0].predicate,
        df.literal([...new Set(quads.map(q => q.object.value))].sort().join(", "))),
    // Keep every distinct value as its own triple (e.g. one schema:availableService
    // per offering) rather than collapsing the group to a single value.
    keepAll: (quads) => {
        const seen = new Set()
        return quads.filter(q => !seen.has(q.object.value) && seen.add(q.object.value))
            .sort((a, b) => a.object.value.localeCompare(b.object.value))
    },
}
const RESOLVE_EXCLUDE = new Set([`${NAMESPACES.schema}identifier`, `${CDP}fromSource`])

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
    // No :ResolveRule (or none with a :defaultStrategy) → longestValue.
    const defaultPick = lookupStrategy(cfg.strategy ?? `${CDP}longestValue`)

    const overrideRows = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?on ?strategy WHERE {
            ?resolve a :ResolveRule ; :hasOverride [ :on ?on ; :strategy ?strategy ] .
        }`, [defStore])
    const overrides = new Map(overrideRows.map(r => [r.on, lookupStrategy(r.strategy)]))

    // Curated corrections (curation.ttl): a :wrong literal is a known
    // source error (e.g. a typo) beyond algorithmic reach. Every occurrence
    // under the :on predicate — scoped by :entity when present, corpus-wide
    // when absent — is rewritten to :right before the strategies pick, so when
    // another source carries the right value the conflict collapses instead of
    // the wrong spelling winning a sort. Applied here, not at merge —
    // merged.ttl stays faithful to what the sources say.
    const corrections = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?entity ?on ?wrong ?right WHERE {
            ?c a :ValueCorrection ; :on ?on ; :wrong ?wrong ; :right ?right .
            OPTIONAL { ?c :entity ?entity }
        }`, [defStore])
    // :entity names the source record carrying the wrong value (the idiom —
    // its IRI lives and dies with the source saying it) or a minted entity;
    // a member IRI is translated to its cluster via the match graph.
    const mintedOf = new Map(store.getQuads(null, HAS_MEMBER, null, MATCH_GRAPH)
        .map(q => [q.object.value, q.subject.value]))
    for (const c of corrections) if (c.entity) c.entity = mintedOf.get(c.entity) ?? c.entity
    let corrected = 0

    const groups = new Map()
    for (let q of store.getQuads(null, null, null, MERGED_GRAPH)) {
        if (RESOLVE_EXCLUDE.has(q.predicate.value)) continue
        const c = corrections.find(c => c.on === q.predicate.value && c.wrong === q.object.value
            && (c.entity == null || c.entity === q.subject.value))
        if (c) { q = df.quad(q.subject, q.predicate, df.literal(c.right)); corrected++ }
        const k = `${q.subject.value}\t${q.predicate.value}`
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(q)
    }
    if (corrected) console.log(`resolve: rewrote ${corrected} literal(s) via curated corrections`)
    const finalQuads = [...groups.values()].flatMap(quads => {
        const picked = (overrides.get(quads[0].predicate.value) ?? defaultPick)(quads)
        return Array.isArray(picked) ? picked : [picked]
    })

    await writeTurtleFile(abs(outPath), finalQuads, { ...COMMON_PREFIXES, cdf: cfg.ns })
    console.log(`resolve: wrote ${finalQuads.length} triples → ${outPath}`)
}
