import { localName, NAMESPACES, parseTtl, PATHS, prefixes } from "../../utils.js"
import { RECORD_CLASS, RECORD_SELECTOR } from "../../fetch/emit.js"
import { writeTurtleFile } from "../write-turtle.js"
import { run } from "../run.js"
import path from "path"
import fs from "fs"

const SPARQL_ANYTHING_VERSION = "v1.1.0"

// A shared budget for concurrent JVMs, held across every source rather than per
// source. Bounds compose multiplicatively: with sources running concurrently and
// each lifting its own files concurrently, two per-scope limits of 3 and 4 would
// permit 12 JVMs, each with its own heap. One global budget is what actually
// bounds the machine.
export const jvmBudget = (limit) => {
    let active = 0
    const queue = []
    const next = () => {
        if (active >= limit || !queue.length) return
        active++
        const { fn, resolve, reject } = queue.shift()
        Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next() })
    }
    return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next() })
}

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
export const runLift = async ({ abs, budget = jvmBudget(1) }, { jar, name, format, params }) => {
    // One JVM per raw file (~1s startup each): fine at small N, costly at
    // nationwide scale. The lever is fewer raw files, not fewer JVMs per file —
    // SPARQL Anything v1.1.0 binds one constant fx:location per invocation
    // (VALUES / -v / directory / archive all fail to feed a per-file location),
    // so a source keeps JVM starts down by having its fetch emit few large files
    // (JSON: merge records into one array; HTML: wrap N entries per file and
    // scope the extract to each wrapper).
    const liftQuery = liftQueryFor(format)
    // A chunked HTML source would otherwise have to restate emit's wrapper class
    // as a lift selector in federation.ttl -- the same contract in two repos,
    // where getting them out of step yields an empty lift. When a raw file
    // actually carries the wrapper and the source declared no selector, the
    // matching one is supplied here.
    //
    // Conditional on the marker being present, which is what makes it safe:
    // core is recognising something emit wrote, not guessing at a convention,
    // and an unchunked source that simply forgot its selector has no wrapper,
    // so it still fails rather than silently lifting nothing.
    const liftOne = async (location, outPath) => {
        const effective = [...params]
        if (formatKey(format) === "html" && !params.some(([n]) => n === "selector") && hasRecordWrapper(location))
            effective.push(["selector", RECORD_SELECTOR])
        const args = ["-jar", jar, "-q", liftQuery,
                      "-v", `location=${location}`,
                      "-f", "TTL", "-o", outPath]
        for (const [pName, value] of effective) args.push("-v", `${pName}=${value}`)
        await run("java", args, { label: name })
    }
    const inAbs = abs(PATHS.raw(name))
    const outAbs = abs(PATHS.lifted(name))
    const files = fs.readdirSync(inAbs).filter(f => !f.startsWith(".")).sort()
    // Clear stale lifted files first — the extract step reads every .ttl here.
    fs.rmSync(outAbs, { recursive: true, force: true })
    fs.mkdirSync(outAbs, { recursive: true })
    console.log(`lift   ${PATHS.raw(name)} (${files.length} files) → ${PATHS.lifted(name)}`)
    // Files of one source lift concurrently, through the shared budget. Each
    // invocation is its own JVM process with no shared state, so this is only a
    // question of how many the machine should run at once -- which is the
    // budget's job, not this loop's. Measured at 2.1x on six files, short of
    // linear because a single JVM already uses more than one core.
    const produced = await Promise.all(files.map((f) => budget(async () => {
        const stem = path.basename(f, path.extname(f))
        const outPath = path.join(outAbs, `${stem}.ttl`)
        await liftOne(path.join(inAbs, f), outPath)
        // No output file at all is a different failure from an empty one: the
        // engine exits 0 and writes nothing when a variable the query references
        // was never bound, so the usual cause is a :hasLiftParam the source
        // never declared. Without this the run aborts on a stat error naming a
        // file nobody asked about.
        if (!fs.existsSync(outPath))
            throw new Error(`lift ${name}: ${f} produced no output at all. `
                + `The ${formatKey(format)} lift query references a variable that was left unbound — `
                + `declare the missing :hasLiftParam (lift params given: ${params.length ? params.map(([n, v]) => `${n}=${v}`).join(", ") : "none"}).`)
        if (!hasTriples(outPath)) return { ok: false, records: 0 }
        return { ok: true, records: await splitChunk(outPath, stem) }
    })))
    const empty = produced.filter((p) => !p.ok).length
    const split = produced.reduce((n, p) => n + p.records, 0)
    if (split) console.log(`lift   ${name}: split ${files.length} chunk(s) into ${split} per-record file(s)`)
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

const formatKey = (format) => localName(String(format)).toLowerCase()

// Whether a raw file carries emit's record wrapper. emit writes the first
// wrapper immediately after the document preamble, so the head of the file is
// enough and a large chunk is never read whole.
const WRAPPER_PROBE_BYTES = 8192
const hasRecordWrapper = (file) => {
    const fd = fs.openSync(file, "r")
    try {
        const buffer = Buffer.alloc(WRAPPER_PROBE_BYTES)
        const read = fs.readSync(fd, buffer, 0, WRAPPER_PROBE_BYTES, 0)
        return buffer.subarray(0, read).toString("utf8").includes(`class="${RECORD_CLASS}"`)
    } finally { fs.closeSync(fd) }
}

// ---- Splitting a chunked lift back into one file per record ---------------
//
// Chunking exists to amortise JVM startup: 1,327 pages in 7 files is 7 JVMs
// instead of 1,327. But it only pays if nothing downstream has to separate the
// records again -- and extract does. One store per lifted file is what stops an
// extract cross-joining across documents, and a chunked file holds many
// documents, so that isolation stops matching the unit of meaning. The extract
// then has to anchor every pattern to its own record and walk down from it,
// which scans the whole file once per record: measured on a real scrape, total
// extract grows as n^1.2 in the chunk size, so a chunk of 190 turns 7 minutes of
// extract into roughly 65 hours and eats the 45 minutes chunking saved many
// times over.
//
// Splitting after triplifying keeps both wins: lift still starts one JVM per
// chunk, and extract still gets one record per store. The same scrape comes out
// at about 7 minutes total against 51 unchunked.
//
// This recognises core's own marker -- emit wrote the wrapper -- rather than
// guessing at an instance's convention, so it is unconditional: a lifted file
// carrying record wrappers is always split.
const XHTML_CLASS     = `${NAMESPACES.xhtml ?? "http://www.w3.org/1999/xhtml#"}class`
const XHTML_DATA_NAME = `${NAMESPACES.xhtml ?? "http://www.w3.org/1999/xhtml#"}data-name`
const XYZ_RECORD      = `${NAMESPACES.xyz}${RECORD_CLASS}`
const XYZ_DATA_NAME   = `${NAMESPACES.xyz}data-name`
const RDF_TYPE        = `${NAMESPACES.rdf}type`

// A record root is an HTML element carrying the wrapper class, or an XML element
// typed as the wrapper. Both shapes were checked against the pinned engine.
const recordRootsOf = (quads) => quads.filter(q =>
    (q.predicate.value === XHTML_CLASS && q.object.value === RECORD_CLASS) ||
    (q.predicate.value === RDF_TYPE && q.object.value === XYZ_RECORD)).map(q => q.subject)

const fileSafe = (name) => String(name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120)

// Partition a lifted chunk into one file per record. Records are disjoint
// blank-node subtrees, so one traversal from each root covers the file exactly
// once -- linear in triples, where the in-query walk it replaces was quadratic.
const splitChunk = async (ttlPath, stem) => {
    const quads = parseTtl(fs.readFileSync(ttlPath, "utf8"))
    const roots = recordRootsOf(quads)
    if (!roots.length) return 0

    const bySubject = new Map()
    for (const q of quads) {
        if (!bySubject.has(q.subject.value)) bySubject.set(q.subject.value, [])
        bySubject.get(q.subject.value).push(q)
    }
    const nameOf = (root) => bySubject.get(root.value)
        ?.find(q => q.predicate.value === XHTML_DATA_NAME || q.predicate.value === XYZ_DATA_NAME)?.object.value

    const dir = path.dirname(ttlPath)
    const used = new Set()
    for (const [index, root] of roots.entries()) {
        // Structure is blank nodes; a NamedNode object is vocabulary, not a
        // child, so following one would drag every record into every file.
        const seen = new Set()
        const subtree = []
        const stack = [root.value]
        while (stack.length) {
            const node = stack.pop()
            if (seen.has(node)) continue
            seen.add(node)
            for (const q of bySubject.get(node) ?? []) {
                subtree.push(q)
                if (q.object.termType === "BlankNode") stack.push(q.object.value)
            }
        }
        let base = fileSafe(nameOf(root) ?? `${stem}-${index}`) || `${stem}-${index}`
        while (used.has(base)) base = `${base}-${index}`
        used.add(base)
        await writeTurtleFile(path.join(dir, `${base}.ttl`), subtree, prefixes("xyz", "rdf"))
    }
    fs.rmSync(ttlPath)
    return roots.length
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
