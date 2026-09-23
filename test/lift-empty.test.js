import { runLift } from "../src/pipeline/steps/lift.js"
import { PATHS } from "@directory-builder/core/utils"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"
import os from "os"
import fs from "fs"

const JAR = path.join(import.meta.dirname, "../example/tools/sparql-anything.jar")

// A chunk written by emit: two records behind the wrapper div.
const CHUNK = `<!DOCTYPE html>
<html><body>
<div class="cdp-record" data-name="a"><html><body><h1>Alpha</h1></body></html></div>
<div class="cdp-record" data-name="b"><html><body><h1>Beta</h1></body></html></div>
</body></html>
`

const stage = (name) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "liftempty-"))
    fs.mkdirSync(path.join(root, PATHS.raw(name)), { recursive: true })
    fs.writeFileSync(path.join(root, PATHS.raw(name), "chunk.html"), CHUNK)
    return { root, abs: (p) => path.join(root, p) }
}

const captureWarnings = async (fn) => {
    const seen = []
    const original = console.warn
    console.warn = (...args) => seen.push(args.join(" "))
    try { await fn() } finally { console.warn = original }
    return seen.join("\n")
}

const HTML = "http://publications.europa.eu/resource/authority/file-type/HTML"

test("a selector that matches nothing is reported at lift, not two steps later", async () => {
    // The real failure: emit writes class="cdp-record", the instance declares a
    // selector that doesn't match it. The lift exits 0 and writes a file holding
    // only prefix declarations, so without this the run looks healthy until the
    // drift check blames the source data or extract.sparql.
    const { abs } = stage("typo")
    const warnings = await captureWarnings(() => runLift({ abs },
        { jar: JAR, name: "typo", format: HTML, params: [["selector", "div.cdp_record"]] }))
    assert.match(warnings, /1 of 1 file\(s\) produced no triples/)
    assert.match(warnings, /selector=div\.cdp_record/, "the params are named, since they are the usual cause")
})

test("a selector that matches stays quiet", async () => {
    const { abs } = stage("ok")
    const warnings = await captureWarnings(() => runLift({ abs },
        { jar: JAR, name: "ok", format: HTML, params: [["selector", "div.cdp-record"]] }))
    assert.equal(warnings, "", "no warning when the lift produced triples")
    // The chunk is split into one file per record, so there is no chunk.ttl —
    // each record's data-name names its own file.
    assert.deepEqual(fs.readdirSync(abs(PATHS.lifted("ok"))).sort(), ["a.ttl", "b.ttl"])
    assert.match(fs.readFileSync(path.join(abs(PATHS.lifted("ok")), "a.ttl"), "utf8"), /Alpha/)
    assert.match(fs.readFileSync(path.join(abs(PATHS.lifted("ok")), "b.ttl"), "utf8"), /Beta/)
})
