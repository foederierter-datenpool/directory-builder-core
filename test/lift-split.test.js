import { runLift, jvmBudget } from "../src/pipeline/steps/lift.js"
import { PATHS, parseTtl } from "@directory-builder/core/utils"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"
import os from "os"
import fs from "fs"

const JAR = path.join(import.meta.dirname, "../example/tools/sparql-anything.jar")
const HTML = "http://publications.europa.eu/resource/authority/file-type/HTML"
const XML  = "http://publications.europa.eu/resource/authority/file-type/XML"

const page = (name, title) =>
    `<div class="cdp-record" data-name="${name}"><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html></div>`
const htmlChunk = (...pages) => `<!DOCTYPE html>\n<html><body>\n${pages.join("\n")}\n</body></html>\n`
const xmlChunk = (...recs) => `<?xml version="1.0" encoding="UTF-8"?>\n<cdp-records>\n${recs.join("\n")}\n</cdp-records>\n`
const xmlRec = (name, id) => `<cdp-record data-name="${name}"><document><id>${id}</id></document></cdp-record>`

const stage = (files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "liftsplit-"))
    fs.mkdirSync(path.join(root, PATHS.raw("s")), { recursive: true })
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, PATHS.raw("s"), name), body)
    return { root, abs: (p) => path.join(root, p) }
}
const lift = (abs, format, params = []) =>
    runLift({ abs, budget: jvmBudget(2) }, { jar: JAR, name: "s", format, params })
const lifted = (abs) => fs.readdirSync(abs(PATHS.lifted("s"))).sort()
const read = (abs, f) => fs.readFileSync(path.join(abs(PATHS.lifted("s")), f), "utf8")

test("a chunked HTML lift becomes one file per record, named by data-name", async () => {
    // The point of the whole change: lift keeps one JVM per chunk, extract gets
    // one record per store. Without this the chunk reaches extract intact and
    // every pattern has to walk the file per record, which is quadratic.
    const { abs } = stage({ "chunk.html": htmlChunk(page("alpha", "Alpha"), page("beta", "Beta"), page("gamma", "Gamma")) })
    await lift(abs, HTML, [["selector", "div.cdp-record"]])
    assert.deepEqual(lifted(abs), ["alpha.ttl", "beta.ttl", "gamma.ttl"])
    assert.match(read(abs, "alpha.ttl"), /Alpha/)
    assert.doesNotMatch(read(abs, "alpha.ttl"), /Beta|Gamma/, "a record's file holds only that record")
})

test("a chunked XML lift splits the same way", async () => {
    const { abs } = stage({ "chunk.xml": xmlChunk(xmlRec("x", "id-x"), xmlRec("y", "id-y")) })
    await lift(abs, XML)
    assert.deepEqual(lifted(abs), ["x.ttl", "y.ttl"])
    assert.match(read(abs, "x.ttl"), /id-x/)
    assert.doesNotMatch(read(abs, "x.ttl"), /id-y/)
})

test("an unchunked lift is untouched", async () => {
    // No wrapper, no split — the file keeps its name and its content.
    const { abs } = stage({ "page.html": "<html><body><h1>Solo</h1></body></html>" })
    await lift(abs, HTML, [["selector", "html"]])
    assert.deepEqual(lifted(abs), ["page.ttl"])
    assert.match(read(abs, "page.ttl"), /Solo/)
})

test("several chunks split into the union of their records", async () => {
    const { abs } = stage({
        "a.html": htmlChunk(page("one", "One"), page("two", "Two")),
        "b.html": htmlChunk(page("three", "Three")),
    })
    await lift(abs, HTML, [["selector", "div.cdp-record"]])
    assert.deepEqual(lifted(abs), ["one.ttl", "three.ttl", "two.ttl"])
})

test("a document name unsafe as a filename is sanitised", async () => {
    const { abs } = stage({ "chunk.html": htmlChunk(page("a/b?c=d&e", "Slashy")) })
    await lift(abs, HTML, [["selector", "div.cdp-record"]])
    const [file] = lifted(abs)
    assert.doesNotMatch(file, /[/?&=]/, `unsafe characters removed: ${file}`)
    assert.match(read(abs, file), /Slashy/)
})

test("records carry no triples from their siblings", async () => {
    // The cross-join this prevents: with records sharing a file, a pattern that
    // is not anchored pairs every value with every record.
    const { abs } = stage({ "chunk.html": htmlChunk(page("p1", "First"), page("p2", "Second")) })
    await lift(abs, HTML, [["selector", "div.cdp-record"]])
    for (const [file, own, other] of [["p1.ttl", "First", "Second"], ["p2.ttl", "Second", "First"]]) {
        const quads = parseTtl(read(abs, file))
        const text = quads.map(q => q.object.value).join(" ")
        assert.ok(text.includes(own), `${file} has its own title`)
        assert.ok(!text.includes(other), `${file} has none of the sibling's`)
    }
})
