import { emit, harvest } from "../src/fetch/index.js"
import { strict as assert } from "assert"
import { test } from "node:test"
import path from "path"
import os from "os"
import fs from "fs"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "emitdoc-"))
const read = (dir) => fs.readdirSync(dir).sort()
const text = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8")
const doc = (name, content) => ({ name, content })
const FAST = { minTimeout: 1, jitter: false }

test("unchunked documents keep one file each, named by the fetcher", async () => {
    const dir = tmp()
    const { written, files } = await emit(
        [doc("page-a", "<html><body>A</body></html>"), doc("page-b", "<html><body>B</body></html>")],
        { outDir: dir, format: "html", mode: "documents" })
    assert.equal(written, 2)
    assert.equal(files, 2)
    assert.deepEqual(read(dir), ["page-a.html", "page-b.html"])
    assert.equal(text(dir, "page-a.html"), "<html><body>A</body></html>")
})

test("a document name that already carries an extension is left alone", async () => {
    const dir = tmp()
    await emit([doc("1234.html", "<p>x</p>")], { outDir: dir, format: "html", mode: "documents" })
    assert.deepEqual(read(dir), ["1234.html"])
})

test("chunking HTML documents wraps each in a scopeable div", async () => {
    const dir = tmp()
    const { files } = await emit(
        [doc("a", "<html><body><h1>Alpha</h1></body></html>"), doc("b", "<html><body><h1>Beta</h1></body></html>")],
        { outDir: dir, format: "html", mode: "documents", chunk: 2 })
    assert.equal(files, 1)
    const out = text(dir, "records-0001.html")
    assert.equal((out.match(/class="cdp-record"/g) ?? []).length, 2)
    assert.match(out, /data-name="a"/)
    assert.match(out, /<h1>Alpha<\/h1>/)
})

test("chunking XML documents strips the inner prologues", async () => {
    const dir = tmp()
    await emit([
        doc("a", '<?xml version="1.0" encoding="UTF-8"?><document><id>a</id></document>'),
        doc("b", '<?xml version="1.0"?><document><id>b</id></document>'),
    ], { outDir: dir, format: "xml", mode: "documents", chunk: 5 })
    const out = text(dir, "records-0001.xml")
    assert.equal((out.match(/<\?xml/g) ?? []).length, 1, "exactly one prologue, the outer one — a nested one is a parse error")
    assert.equal((out.match(/<cdp-record /g) ?? []).length, 2)
})

test("document names are attribute-escaped into the wrapper", async () => {
    const dir = tmp()
    await emit([doc('a"&<b', "<p>x</p>")], { outDir: dir, format: "html", mode: "documents", chunk: 2 })
    const out = text(dir, "records-0001.html")
    assert.match(out, /data-name="a&quot;&amp;&lt;b"/)
})

test("chunked documents respect the chunk size", async () => {
    const dir = tmp()
    const docs = Array.from({ length: 7 }, (_, i) => doc(`d${i}`, `<p>${i}</p>`))
    const { written, files } = await emit(docs, { outDir: dir, format: "html", mode: "documents", chunk: 3 })
    assert.equal(written, 7)
    assert.equal(files, 3)
})

test("projection is refused in document mode", async () => {
    await assert.rejects(
        () => emit([doc("a", "<p>x</p>")], { outDir: tmp(), format: "html", mode: "documents", project: (d) => d }),
        /project does not apply in document mode/)
})

test("formats with no wrapper cannot chunk documents", async () => {
    for (const format of ["json", "csv", "xlsx"])
        await assert.rejects(
            () => emit([doc("a", "x")], { outDir: tmp(), format, mode: "documents", chunk: 2 }),
            /cannot chunk/, `${format} has no wrapper the lift can be scoped to`)
})

test("a document without a name fails rather than writing an unnamed file", async () => {
    await assert.rejects(
        () => emit([{ content: "<p>x</p>" }], { outDir: tmp(), format: "html", mode: "documents" }),
        /a document needs a name/)
})

test("validation applies to documents exactly as it does to records", async () => {
    const dir = tmp()
    await assert.rejects(() => emit(harvest({
        fetchOne: async (_p, page) => ({ items: page === 1 ? [doc("a", "x")] : [], total: 9 }),
        retry: FAST,
    }), { outDir: dir, format: "html", mode: "documents" }), /truncated|reported 9/)
})

test("a two-phase scrape ends with one document per discovered URL", async () => {
    const dir = tmp()
    const urls = ["/a", "/b", "/c"]
    const { written, files } = await emit(harvest({
        partitions: urls,
        fetchOne: async (url) => ({ items: [doc(url.slice(1), `<html><body><h1>${url}</h1></body></html>`)], total: 1 }),
        concurrency: 2,
        retry: FAST,
    }), { outDir: dir, format: "html", mode: "documents", chunk: 200, expect: { total: urls.length } })
    assert.equal(written, 3)
    assert.equal(files, 1, "1349 pages at chunk 200 is 7 JVMs at lift, not 1349")
})

test("mode must be one of the two", async () => {
    await assert.rejects(() => emit([], { outDir: tmp(), mode: "nonsense" }), /mode must be/)
})
