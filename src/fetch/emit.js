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

// Document mode: opaque bytes plus a filename, for sources that fetch pages
// rather than records. Chunking several documents into one file is what takes a
// scrape from one JVM per page to one per chunk, but it is not free: the
// wrapper changes the file's structure, so the source's extract must scope to
// it. Both wrappers below were checked against the pinned SPARQL Anything.
//
// HTML — each document goes in a div carrying the record class, and the lift's
// :hasLiftParam selector becomes "div.cdp-record". jsoup drops the nested
// html/head/body tags but hoists their content into the div, so titles, links
// and body content survive; a <link rel="canonical"> injected by a fetcher to
// carry the entity id survives too. An extract that scoped on "head" or "body"
// must move to the div.
//
// XML — each document goes in a cdp-record element under one cdp-records root.
// The inner XML prologues have to go: a nested <?xml ?> is a hard parse error,
// not a warning.
const RECORD_CLASS = "cdp-record"

const WRAPPERS = {
    html: {
        ext: "html",
        wrap: (docs) => `<!DOCTYPE html>\n<html><body>\n`
            + docs.map((d) => `<div class="${RECORD_CLASS}" data-name="${escapeAttr(d.name)}">\n${d.content}\n</div>`).join("\n")
            + `\n</body></html>\n`,
    },
    xml: {
        ext: "xml",
        wrap: (docs) => `<?xml version="1.0" encoding="UTF-8"?>\n<cdp-records>\n`
            + docs.map((d) => `<${RECORD_CLASS} data-name="${escapeAttr(d.name)}">${stripProlog(d.content)}</${RECORD_CLASS}>`).join("\n")
            + `\n</cdp-records>\n`,
    },
}

const escapeAttr = (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
const stripProlog = (xml) => String(xml).replace(/^\uFEFF?\s*<\?xml[^?]*\?>\s*/i, "")

const UNCHUNKABLE = {
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
    mode = "records",
    project,
    chunk = Infinity,
    expect: expectations = {},
    stem = "records",
} = {}) => {
    if (!outDir) throw new TypeError("emit needs an outDir")
    if (!["records", "documents"].includes(mode)) throw new TypeError(`emit mode must be "records" or "documents"`)
    const key = formatKey(format)
    if (UNCHUNKABLE[key] && chunk !== Infinity) throw new Error(`emit cannot chunk ${key}: ${UNCHUNKABLE[key]}`)

    const documents = mode === "documents"
    // Projection means dropping fields, which for an opaque document means
    // parsing it — and parsing the payload is lift's job, not the fetcher's.
    if (documents && project) throw new Error("emit: project does not apply in document mode — dropping fields from raw markup means parsing it, which is the lift step's job")

    const writer = documents ? null : WRITERS[key]
    if (!documents && !writer) throw new Error(WRAPPERS[key]
        // Markup is not a record shape: there is no sensible way to serialise a
        // parsed object as HTML or XML here. These arrive as fetched documents.
        ? `emit cannot write ${key} from records — it is a document format, so pass mode: "documents" with { name, content } items`
        : `emit has no writer for format "${key}" — use ${Object.keys(WRITERS).join(" or ")}`)
    const wrapper = documents && chunk !== Infinity ? WRAPPERS[key] : null
    if (documents && chunk !== Infinity && !wrapper)
        throw new Error(`emit cannot chunk ${key} documents — only ${Object.keys(WRAPPERS).join(" and ")} have a wrapper the lift can be scoped to`)
    const ext = documents ? (wrapper?.ext ?? key) : writer.ext

    fs.mkdirSync(outDir, { recursive: true })

    let written = 0, files = 0, reportedTotal, truncated = false
    let buffer = []

    const flush = () => {
        if (!buffer.length) return
        const name = `${stem}-${String(++files).padStart(4, "0")}.${ext}`
        fs.writeFileSync(path.join(outDir, name), documents ? wrapper.wrap(buffer) : writer.write(buffer))
        buffer = []
    }

    // Unchunked documents keep one file each, named by the fetcher — the
    // existing behaviour of every scrape, and the only option when the format
    // has no wrapper.
    const writeOne = (doc) => {
        if (!doc?.name) throw new Error("emit: a document needs a name — { name, content }")
        files++
        fs.writeFileSync(path.join(outDir, doc.name.includes(".") ? doc.name : `${doc.name}.${ext}`), doc.content)
    }

    for await (const batch of normalise(source)) {
        // A partition that reported its size contributes to the expected count;
        // one that reported nothing leaves reportedTotal undefined, and the
        // minRecords floor is the only check available.
        if (batch.total != null) reportedTotal = (reportedTotal ?? 0) + batch.total
        if (batch.truncated) truncated = true
        for (const item of batch.items) {
            written++
            if (documents && !wrapper) { writeOne(item); continue }
            buffer.push(documents ? item : (project ? project(item) : item))
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
