import { sparqlConstruct, storeFromTurtles } from "@foerderfunke/sem-ops-utils"
import { CDP, identifierFieldPath, PATHS, sourceName } from "../../utils.js"
import { writeTurtleFile } from "../write-turtle.js"
import path from "path"
import fs from "fs"

// The default clean ships with the engine, like the lift queries.
const DEFAULT_CLEAN = path.join(import.meta.dirname, "../../clean/default.sparql")

// Clean step: the source's clean.sparql reshapes its lifted RDF into
// federation subjects (xyz:/cdp: vocabulary only — schema: enters at map).
// clean.sparql is optional when the source maps a field to schema:identifier:
// the engine then derives the default clean from that mapping.
export const runClean = async ({ abs, quads }, sourceIri) => {
    const name = sourceName(sourceIri)
    const cleanQuery = fs.existsSync(abs(PATHS.cleanQuery(name)))
        ? fs.readFileSync(abs(PATHS.cleanQuery(name)), "utf8")
        : defaultClean({ abs, quads }, sourceIri, name)
    const inDir = PATHS.lifted(name)
    const outPath = PATHS.cleaned(name)
    // Run CONSTRUCT per file so each lifted TTL stays isolated in its
    // own store — the clean SPARQL can't cross-join across documents.
    const inAbs = abs(inDir)
    const files = fs.readdirSync(inAbs).filter(f => f.endsWith(".ttl")).sort()
    console.log(`clean  ${inDir} (${files.length} files) → ${outPath}`)
    const allQuads = []
    for (const f of files) {
        const fileStore = storeFromTurtles([fs.readFileSync(path.join(inAbs, f), "utf8")])
        allQuads.push(...await sparqlConstruct(cleanQuery, [fileStore]))
    }
    await writeTurtleFile(abs(outPath), allQuads, {
        xyz: "http://sparql.xyz/facade-x/data/",
        cdp: CDP,
    })
}

// No clean.sparql given: resolve the engine's default template with the
// source's identifier field as skolem key, and put the applied query on
// record under data/ — no silent fallbacks.
const defaultClean = ({ abs, quads }, sourceIri, name) => {
    const idPath = identifierFieldPath(quads, sourceIri)
    if (!idPath) throw new Error(`${PATHS.cleanQuery(name)} missing and no schema:identifier mapping to derive the default clean from`)
    const query = fs.readFileSync(DEFAULT_CLEAN, "utf8")
        .replaceAll("__source__", `<${sourceIri}>`).replaceAll("__name__", name).replaceAll("__idPath__", idPath)
    const outPath = abs(PATHS.defaultCleanQuery(name))
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, query)
    console.log(`clean  ${name} default (id field: ${idPath}) → ${PATHS.defaultCleanQuery(name)}`)
    return query
}
