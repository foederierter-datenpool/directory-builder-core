import { localName, PATHS } from "../../utils.js"
import { run } from "../run.js"
import path from "path"
import fs from "fs"

const SPARQL_ANYTHING_VERSION = "v1.1.0"

// The generic lift queries ship with the engine — they resolve against this
// package, not the instance root like everything else in PATHS.
const liftQueryFor = (formatIri) =>
    path.join(import.meta.dirname, "../../lift", `${localName(formatIri).toLowerCase()}.sparql`)

// SPARQL Anything is the lift tool — cached per instance (tools/, gitignored),
// downloaded on first run and re-downloaded on version bumps.
export async function ensureJar(abs) {
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
    return JAR
}

// Lift step: SPARQL Anything turns each raw file into TTL, via the bundled
// query for the source's :format, with the source's :hasLiftParam variables.
export const runLift = ({ abs }, { jar, name, format, params }) => {
    // TODO: directory mode spawns one JVM per file (~1s startup each).
    // Fine at small N; revisit if a source crosses ~50 items. SPARQL Anything
    // accepts VALUES ?_location { … } in the lift query, which would let one
    // invocation handle the whole batch.
    const liftQuery = liftQueryFor(format)
    const liftOne = (location, outPath) => {
        const args = ["-jar", jar, "-q", liftQuery,
                      "-v", `location=${location}`,
                      "-f", "TTL", "-o", outPath]
        for (const [pName, value] of params) args.push("-v", `${pName}=${value}`)
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
}
