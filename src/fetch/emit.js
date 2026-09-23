// Shared fetch primitives — tranche 3: validation, projection and chunking.
//
// emit is the half that deals with what you got, however you got it, so a
// static source that makes no requests uses it on its own — that is the test
// of the split, and one source already hand-rolls exactly this (splitting one
// large export into per-record files, with no network involved).
import { localName } from "../utils.js"
import path from "path"
import fs from "fs"

// Chunking is format-dependent because the fetch/lift contract is: the file
// extension picks the triplifier, the file count is the JVM count, and for some
// formats the file structure dictates how the extract must be scoped.
//
// Only the two formats whose chunking is a pure fetch concern are implemented
// here. HTML and XML need a wrapper element *and a matching change to the
// source's extract.sparql*, so they are not something this can do silently;
// XLSX is a zip container that no byte-level tool can split. Those are the next
// tranche, and they fail loudly rather than writing something lift will
// misread.
const WRITERS = {
    json: {
        ext: "json",
        write: (records) => JSON.stringify(records, null, 2),
    },
    csv: {
        ext: "csv",
        // Every chunk repeats the header row: each file is lifted independently,
        // and a headerless chunk would have its first data row read as headers.
        write: (records) => {
            const columns = [...new Set(records.flatMap((r) => Object.keys(r)))]
            const cell = (v) => {
                const s = v == null ? "" : String(v)
                return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
            }
            return [columns.join(","), ...records.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n"
        },
    },
}

const UNSUPPORTED = {
    html: "HTML chunking needs the records wrapped in a container element and the source's extract.sparql scoped to that wrapper",
    xml:  "XML chunking needs the documents wrapped under a root element and the source's extract.sparql scoped to it",
    xlsx: "XLSX is a zip container and cannot be chunked by a byte-level tool",
}

// :format is an IRI in config (.../file-type/JSON); a caller may also pass the
// short name. Normalised the same way lift picks its query, so the two cannot
// disagree about what a format is called.
const formatKey = (format) => localName(String(format)).toLowerCase()

// Write records to outDir, validating the harvest and chunking for lift.
//
//     await emit(harvest({ ... }), { outDir, format, chunk: 500 })
//     await emit(recordsArray,     { outDir, format, expect: { minRecords: 100 } })
//
// Accepts either an array of records or the async iterable harvest returns.
// Consuming the iterable is what keeps memory bounded: records are written out
// a chunk at a time instead of being gathered first, which is the whole reason
// harvest yields per partition.
//
// Passing harvest's output also makes validation automatic — the reported total
// and the truncation flag travel with the batches, so the count check needs no
// argument from the author. It is that check, not the writing, that this is for:
// a run that fetched 10,000 of 246,947 records produces output where every
// mapped field is present, so nothing downstream can notice.
export const emit = async (source, {
    outDir,
    format = "json",
    project,
    chunk = Infinity,
    expect: expectations = {},
    stem = "records",
} = {}) => {
    if (!outDir) throw new TypeError("emit needs an outDir")
    const key = formatKey(format)
    if (UNSUPPORTED[key]) throw new Error(`emit cannot chunk ${key}: ${UNSUPPORTED[key]}`)
    const writer = WRITERS[key]
    if (!writer) throw new Error(`emit has no writer for format "${key}" — use ${Object.keys(WRITERS).join(" or ")}`)

    fs.mkdirSync(outDir, { recursive: true })

    let written = 0, files = 0, reportedTotal, truncated = false
    let buffer = []

    const flush = () => {
        if (!buffer.length) return
        const name = `${stem}-${String(++files).padStart(4, "0")}.${writer.ext}`
        fs.writeFileSync(path.join(outDir, name), writer.write(buffer))
        buffer = []
    }

    for await (const batch of normalise(source)) {
        // A partition that reported its size contributes to the expected count;
        // one that reported nothing leaves reportedTotal undefined, and the
        // minRecords floor is the only check available.
        if (batch.total != null) reportedTotal = (reportedTotal ?? 0) + batch.total
        if (batch.truncated) truncated = true
        for (const record of batch.items) {
            buffer.push(project ? project(record) : record)
            written++
            if (buffer.length >= chunk) flush()
        }
    }
    flush()

    const expectedTotal = expectations.total ?? reportedTotal
    if (truncated)
        throw new Error(`emit: the source truncated the harvest — wrote ${written} records against a reported total of ${expectedTotal ?? "unknown"}. The source stopped returning results before its total was reached (a result cap); partition the harvest more finely.`)
    if (expectedTotal != null && written !== expectedTotal)
        throw new Error(`emit: harvested ${written} records but the source reported ${expectedTotal}`)
    if (expectations.minRecords != null && written < expectations.minRecords)
        throw new Error(`emit: harvested ${written} records, below the expected floor of ${expectations.minRecords} — the source layout may have changed`)

    console.log(`emit   ${written} records → ${files} file(s) in ${outDir}`)
    return { written, files, total: expectedTotal }
}

// An array of records, or harvest's per-partition results, reach the same loop.
async function* normalise(source) {
    if (Array.isArray(source)) { yield { items: source }; return }
    if (source?.[Symbol.asyncIterator]) { yield* source; return }
    throw new TypeError("emit needs an array of records or the async iterable harvest returns")
}
