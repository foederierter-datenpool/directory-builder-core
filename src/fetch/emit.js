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
// :hasLiftParam selector has to match it:
//
//     :hasLiftParam [ :name "selector" ; :value "div.cdp-record" ]
//
// That is the same contract written in two repos. It cannot be removed from
// here, because emit runs inside the fetcher's own process and nothing in the
// config records that a source chose to chunk — so the engine cannot default
// the selector without breaking an unchunked source that merely forgot one.
// What it gets instead: the string has a single home (RECORD_SELECTOR below,
// which a fetcher can assert against), and a selector that does not match is
// reported by the lift step rather than surfacing two steps later as a drift
// error blaming the extract. XML needs none of this — its lift takes no
// selector, so there is nothing to keep in step.
//
// jsoup drops the nested
// html/head/body tags but hoists their content into the div, so titles, links
// and body content survive; a <link rel="canonical"> injected by a fetcher to
// carry the entity id survives too. An extract that scoped on "head" or "body"
// must move to the div.
//
// XML — each document goes in a cdp-record element under one cdp-records root.
// The inner XML prologues have to go: a nested <?xml ?> is a hard parse error,
// not a warning.
//
// ---- Reading a chunk back -------------------------------------------------
//
// Nothing special. The lift step splits a chunk into one file per record before
// extract sees it, so a chunked source's extract is the same free-floating query
// an unchunked source writes -- one record per store, patterns unambiguous.
//
// Two contracts worth relying on:
//
//   • The name passed to emit names the record's lifted file, and reaches the
//     extract as data-name on the record element. That is the record's identity,
//     and it saves a source-specific id trick -- a slug regexed out of a
//     canonical URL, say.
//   • <link> and <meta> from each document's head survive inside the record
//     rather than being hoisted out of it, so an extract may depend on them.
//
// Chunk size is now purely a lift concern: more records per file is fewer JVM
// starts, and extract is unaffected because it never sees the chunk. Before the
// split existed, the chunk reached extract intact and every pattern had to be
// anchored to its own record and walked down from -- which scanned the whole
// file per record and cost more than the JVM starts it saved.

export const RECORD_CLASS = "cdp-record"

// The lift selector that matches what the HTML wrapper writes. Exported so a
// fetcher and its federation.ttl cannot drift apart silently: the class lives
// here, and this is the one string the config has to agree with.
//
//     :hasLiftParam [ :name "selector" ; :value "div.cdp-record" ]
export const RECORD_SELECTOR = `div.${RECORD_CLASS}`

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
// `project` trims each record before it is written. Prefer a size cap that
// exempts the mapped fields over naming the fields to drop: measured across one
// real source, the bulk sits in a *different* field in different slices (median
// record 59 KB, largest 2.3 MB, and the single biggest field was absent from a
// deny-list drawn up from the first page), so a hand-maintained list silently
// stops working the next time the API adds a blob. The exemption is the
// load-bearing half — a mapped field can legitimately be far larger than the
// threshold that catches the rest. The rule is a callback rather than config
// precisely because it is not expressible as a field list.
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

    // written counts what lands on disk; fetched counts what the source handed
    // over before dedup. The completeness check compares fetched against the
    // reported total, so a deduped duplicate is not mistaken for a lost record.
    let written = 0, fetched = 0, files = 0, reportedTotal, truncated = false, capped = false
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
        fetched += batch.fetched ?? batch.items.length
        if (batch.truncated) truncated = true
        if (batch.capped) capped = true
        for (const item of batch.items) {
            written++
            if (documents && !wrapper) { writeOne(item); continue }
            buffer.push(documents ? item : (project ? project(item) : item))
            if (buffer.length >= chunk) flush()
        }
    }
    flush()

    const expectedTotal = expectations.total ?? reportedTotal
    const deduped = fetched - written
    const seenNote = deduped > 0 ? ` (${deduped} deduplicated)` : ""
    if (truncated)
        throw new Error(`emit: the source truncated the harvest — received ${fetched} records against a reported total of ${expectedTotal ?? "unknown"}. The source stopped returning results before its total was reached (a result cap); partition the harvest more finely.`)
    // A deliberate cap is not a shortfall. Without this every capped run would
    // have to restate its own expected count -- and round it to a page boundary,
    // since harvest fetches whole pages -- in each adopting fetcher.
    if (expectedTotal != null && fetched !== expectedTotal && !capped)
        throw new Error(`emit: received ${fetched} records but the source reported ${expectedTotal}${seenNote}`)
    if (expectations.minRecords != null && written < expectations.minRecords)
        throw new Error(`emit: harvested ${written} records, below the expected floor of ${expectations.minRecords} — the source layout may have changed`)

    const capNote = capped ? ` (capped, of ${expectedTotal ?? "unknown"} available)` : ""
    console.log(`emit   ${written} records${seenNote}${capNote} → ${files} file(s) in ${outDir}`)
    return { written, fetched, deduplicated: deduped, files, total: expectedTotal, capped }
}

// An array of records, or harvest's per-partition results, reach the same loop.
async function* normalise(source) {
    if (Array.isArray(source)) { yield { items: source }; return }
    if (source?.[Symbol.asyncIterator]) { yield* source; return }
    throw new TypeError("emit needs an array of records or the async iterable harvest returns")
}
