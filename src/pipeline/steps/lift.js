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
export const runLift = async ({ abs }, { jar, name, format, params }) => {
    // One JVM per raw file (~1s startup each): fine at small N, costly at
    // nationwide scale. The lever is fewer raw files, not fewer JVMs per file —
    // SPARQL Anything v1.1.0 binds one constant fx:location per invocation
    // (VALUES / -v / directory / archive all fail to feed a per-file location),
    // so a source keeps JVM starts down by having its fetch emit few large files
    // (JSON: merge records into one array; HTML: wrap N entries per file and
    // scope the extract to each wrapper).
    const liftQuery = liftQueryFor(format)
    const liftOne = async (location, outPath) => {
        const args = ["-jar", jar, "-q", liftQuery,
                      "-v", `location=${location}`,
                      "-f", "TTL", "-o", outPath]
        for (const [pName, value] of params) args.push("-v", `${pName}=${value}`)
        await run("java", args, { label: name })
    }
    const inAbs = abs(PATHS.raw(name))
    const outAbs = abs(PATHS.lifted(name))
    const files = fs.readdirSync(inAbs).filter(f => !f.startsWith(".")).sort()
    // Clear stale lifted files first — the extract step reads every .ttl here.
    fs.rmSync(outAbs, { recursive: true, force: true })
    fs.mkdirSync(outAbs, { recursive: true })
    console.log(`lift   ${PATHS.raw(name)} (${files.length} files) → ${PATHS.lifted(name)}`)
    let empty = 0
    for (const f of files) {
        const stem = path.basename(f, path.extname(f))
        const outPath = path.join(outAbs, `${stem}.ttl`)
        await liftOne(path.join(inAbs, f), outPath)
        if (!hasTriples(outPath)) empty++
    }
    // A lift that matched nothing still exits 0 and writes a file holding only
    // prefix declarations, so the run looks healthy and the failure surfaces two
    // steps later as a drift error blaming the source data or extract.sparql.
    // The cause is knowable here and nowhere else: the query, the format and the
    // params are all in hand. Reported rather than thrown, because a source can
    // legitimately harvest nothing; the drift check still fails the run.
    if (empty) {
        const shown = params.length ? params.map(([n, v]) => `${n}=${v}`).join(", ") : "none"
        console.warn(`lift   ${name}: ${empty} of ${files.length} file(s) produced no triples — `
            + `the ${localName(format).toLowerCase()} lift matched nothing in them (lift params: ${shown}). `
            + `A selector or format that does not match the raw files is the usual cause.`)
    }
}

// Whether a lifted Turtle file holds anything beyond its prefix header.
// SPARQL Anything writes prefixes first, so anything past a few kilobytes
// certainly has content and only a small file needs reading.
const PREFIX_HEADER_BYTES = 8192
const hasTriples = (file) => {
    const { size } = fs.statSync(file)
    if (size > PREFIX_HEADER_BYTES) return true
    return fs.readFileSync(file, "utf8")
        .split("\n")
        .some(line => line.trim() !== "" && !/^\s*(@?prefix|PREFIX)\s/i.test(line))
}
