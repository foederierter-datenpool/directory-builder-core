import { emit, harvest } from "../src/fetch/index.js"
import { strict as assert } from "assert"
import { test } from "node:test"
import path from "path"
import os from "os"
import fs from "fs"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "emit-"))
const read = (dir) => fs.readdirSync(dir).sort()
const json = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
const text = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8")

const FAST = { minTimeout: 1, jitter: false }

test("emit writes an array of records as one JSON file", async () => {
    const dir = tmp()
    const { written, files } = await emit([{ id: 1 }, { id: 2 }], { outDir: dir, format: "json" })
    assert.equal(written, 2)
    assert.equal(files, 1)
    assert.deepEqual(read(dir), ["records-0001.json"])
    assert.deepEqual(json(dir, "records-0001.json"), [{ id: 1 }, { id: 2 }])
})

test("emit accepts the :format IRI the config actually carries", async () => {
    const dir = tmp()
    await emit([{ id: 1 }], { outDir: dir, format: "http://publications.europa.eu/resource/authority/file-type/JSON" })
    assert.deepEqual(read(dir), ["records-0001.json"])
})

test("emit chunks to bound the JVM count at lift", async () => {
    const dir = tmp()
    const records = Array.from({ length: 7 }, (_, i) => ({ id: i }))
    const { files } = await emit(records, { outDir: dir, format: "json", chunk: 3 })
    assert.equal(files, 3)
    assert.deepEqual(read(dir), ["records-0001.json", "records-0002.json", "records-0003.json"])
    assert.equal(json(dir, "records-0003.json").length, 1, "the remainder lands in a final short chunk")
})

test("every CSV chunk repeats the header row", async () => {
    const dir = tmp()
    await emit([{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }],
        { outDir: dir, format: "csv", chunk: 2 })
    assert.deepEqual(read(dir), ["records-0001.csv", "records-0002.csv"])
    assert.equal(text(dir, "records-0001.csv"), "id,name\n1,a\n2,b\n")
    assert.equal(text(dir, "records-0002.csv"), "id,name\n3,c\n",
        "a headerless chunk would have its first data row lifted as headers")
})

test("CSV quoting survives commas, quotes and newlines", async () => {
    const dir = tmp()
    await emit([{ a: 'say "hi"', b: "x,y", c: "line1\nline2", d: null }], { outDir: dir, format: "csv" })
    assert.equal(text(dir, "records-0001.csv"), 'a,b,c,d\n"say ""hi""","x,y","line1\nline2",\n')
})

test("project drops unmapped fields before anything is written", async () => {
    const dir = tmp()
    await emit([{ id: 1, keep: "y", huge: "x".repeat(1000) }], {
        outDir: dir, format: "json",
        project: ({ id, keep }) => ({ id, keep }),
    })
    assert.deepEqual(json(dir, "records-0001.json"), [{ id: 1, keep: "y" }])
})

test("emit consumes harvest's output directly, without gathering it first", async () => {
    const dir = tmp()
    const { written, files } = await emit(harvest({
        partitions: ["a", "b"],
        fetchOne: async (p, page) => ({ items: page === 1 ? [{ p, n: 1 }, { p, n: 2 }] : [], total: 2 }),
        concurrency: 1,
        retry: FAST,
    }), { outDir: dir, format: "json", chunk: 3 })
    assert.equal(written, 4)
    assert.equal(files, 2)
})

test("the count check uses the totals harvest carries, with no argument from the author", async () => {
    const dir = tmp()
    // Reports 10, yields 3. harvest sees the short partition and flags it, so the
    // truncation error is the one that fires — the shortfall is caught either way,
    // but this names which check does it.
    await assert.rejects(() => emit(harvest({
        fetchOne: async (_p, page) => ({ items: page === 1 ? [1, 2, 3] : [], total: 10 }),
        retry: FAST,
    }), { outDir: dir, format: "json" }),
    (e) => {
        assert.match(e.message, /truncated/)
        assert.match(e.message, /wrote 3 records against a reported total of 10/)
        return true
    })
})

test("a truncated harvest fails rather than producing a plausible-looking directory", async () => {
    const dir = tmp()
    await assert.rejects(() => emit(harvest({
        // the capped-API shape: 200 + empty past the ceiling, true total still reported
        fetchOne: async (_p, page) => ({ items: page <= 2 ? [page] : [], total: 50 }),
        retry: FAST,
    }), { outDir: dir, format: "json" }),
    (e) => {
        assert.match(e.message, /truncated/)
        assert.match(e.message, /50/, "the error states both numbers")
        return true
    })
})

test("expect.total overrides what the source claims", async () => {
    const dir = tmp()
    await assert.rejects(
        () => emit([{ id: 1 }], { outDir: dir, format: "json", expect: { total: 2 } }),
        /harvested 1 records but the source reported 2/)
})

test("a minRecords floor catches a source whose layout changed", async () => {
    const dir = tmp()
    await assert.rejects(
        () => emit([{ id: 1 }], { outDir: dir, format: "json", expect: { minRecords: 100 } }),
        /below the expected floor of 100/)
})

test("validation passes when the count matches the reported total", async () => {
    const dir = tmp()
    const { written } = await emit(harvest({
        fetchOne: async (_p, page) => ({ items: page === 1 ? [1, 2, 3] : [], total: 3 }),
        retry: FAST,
    }), { outDir: dir, format: "json" })
    assert.equal(written, 3)
})

test("no reported total leaves minRecords as the only available check", async () => {
    const dir = tmp()
    const { written, total } = await emit(harvest({
        fetchOne: async (_p, page) => ({ items: page === 1 ? [1, 2] : [] }),
        retry: FAST,
    }), { outDir: dir, format: "json", expect: { minRecords: 2 } })
    assert.equal(written, 2)
    assert.equal(total, undefined)
})

test("record mode points markup formats at document mode instead of guessing", async () => {
    const dir = tmp()
    for (const format of ["html", "xml"])
        await assert.rejects(() => emit([{ a: 1 }], { outDir: dir, format }),
            /it is a document format, so pass mode: "documents"/,
            `${format} has no record serialisation — it arrives as fetched documents`)
})

test("emit refuses to chunk a format no byte-level tool can split", async () => {
    await assert.rejects(() => emit([{ a: 1 }], { outDir: tmp(), format: "xlsx", chunk: 2 }), /zip container/)
})

test("emit rejects a format it has no writer for", async () => {
    await assert.rejects(() => emit([{ a: 1 }], { outDir: tmp(), format: "yaml" }), /no writer for format "yaml"/)
})

test("emit requires an outDir and a supported source", async () => {
    await assert.rejects(() => emit([{ a: 1 }], {}), /needs an outDir/)
    await assert.rejects(() => emit("not records", { outDir: tmp() }), /array of records or the async iterable/)
})
