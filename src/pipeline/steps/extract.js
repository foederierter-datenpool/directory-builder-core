import { newStore, sparqlConstruct, storeFromTurtles } from "@foerderfunke/sem-ops-utils"
import { CDP, identifierField, PATHS, prefixes, sourceName } from "../../utils.js"
import { writeTurtleFile } from "../write-turtle.js"
import path from "path"
import fs from "fs"

// The default extract ships with the engine, like the lift queries.
const DEFAULT_EXTRACT = path.join(import.meta.dirname, "../../extract/default.sparql")

// One triple per source saying when ingest last fetched it, lifted out of the
// ingest log so an extract can read it:
//
//     cdp:<source> cdp:observedAt "2026-08-28T11:28:15.147Z"^^xsd:dateTime
//
// Read from the log on disk rather than threaded through from ingest, which is
// what makes a federate-only re-run see the *previous* ingest's time — the
// correct "as observed at" semantics, and the reason a time-relative extract
// stays deterministic where NOW() would not. Never ingested (no log yet) → an
// empty store, and the extract's pattern simply doesn't bind.
export const harvestObservations = async (abs) => {
    const store = newStore()
    const logPath = abs(PATHS.ingestLog)
    if (!fs.existsSync(logPath)) return store
    const logStore = storeFromTurtles([fs.readFileSync(logPath, "utf8")])
    await sparqlConstruct(`
        PREFIX : <${CDP}>
        PREFIX prov: <${prefixes("prov").prov}>
        CONSTRUCT { ?source :observedAt ?time } WHERE {
            [] :harvested [ :ofSource ?source ; prov:atTime ?time ]
        }`, [logStore], store)
    return store
}

// Extract step: the source's extract.sparql reshapes its lifted RDF into
// federation subjects (xyz:/cdp: vocabulary only — schema: enters at map).
// extract.sparql is optional when the source maps a field to schema:identifier:
// the engine then derives the default extract from that mapping.
export const runExtract = async ({ abs, quads, observations }, sourceIri) => {
    const name = sourceName(sourceIri)
    const extractQuery = fs.existsSync(abs(PATHS.extractQuery(name)))
        ? fs.readFileSync(abs(PATHS.extractQuery(name)), "utf8")
        : defaultExtract({ abs, quads }, sourceIri, name)
    const inDir = PATHS.lifted(name)
    const outPath = PATHS.extracted(name)
    // Run CONSTRUCT per file so each lifted TTL stays isolated in its
    // own store — the extract SPARQL can't cross-join across documents.
    const inAbs = abs(inDir)
    const files = fs.readdirSync(inAbs).filter(f => f.endsWith(".ttl")).sort()
    console.log(`extract  ${inDir} (${files.length} files) → ${outPath}`)
    const allQuads = []
    for (const f of files) {
        const fileStore = storeFromTurtles([fs.readFileSync(path.join(inAbs, f), "utf8")])
        // The observation store rides alongside the document: additive and
        // opt-in, so an extract that ignores cdp:observedAt is unaffected.
        allQuads.push(...await sparqlConstruct(extractQuery, [fileStore, observations ?? newStore()]))
    }
    await writeTurtleFile(abs(outPath), allQuads, prefixes("xyz", "cdp"))
}

// No extract.sparql given: resolve the engine's default template with the
// source's :iriSource field as skolem key, and put the applied query on
// record under data/ — no silent fallbacks. The template URI-escapes the key
// (ENCODE_FOR_URI), so any field value mints a syntactically valid IRI.
const defaultExtract = ({ abs, quads }, sourceIri, name) => {
    const idPath = identifierField(quads, sourceIri)
    if (!idPath) throw new Error(`${PATHS.extractQuery(name)} missing and no :iriSource field to derive the default extract from`)
    const query = fs.readFileSync(DEFAULT_EXTRACT, "utf8")
        .replaceAll("__source__", `<${sourceIri}>`).replaceAll("__name__", name).replaceAll("__idPath__", idPath)
    const outPath = abs(PATHS.defaultExtractQuery(name))
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, query)
    console.log(`extract  ${name} default (id field: ${idPath}) → ${PATHS.defaultExtractQuery(name)}`)
    return query
}
