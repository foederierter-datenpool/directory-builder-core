import { sparqlConstruct, storeFromTurtles } from "@foerderfunke/sem-ops-utils"
import { writeTurtleFile } from "../write-turtle.js"
import { CDP, PATHS } from "../../utils.js"
import path from "path"
import fs from "fs"

// Clean step: the source's clean.sparql reshapes its lifted RDF into
// federation subjects (xyz:/cdp: vocabulary only — schema: enters at map).
export const runClean = async ({ abs }, name) => {
    const cleanQuery = fs.readFileSync(abs(PATHS.cleanQuery(name)), "utf8")
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
