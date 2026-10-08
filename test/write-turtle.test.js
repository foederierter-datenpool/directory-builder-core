import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { DataFactory as df } from "n3"
import { parseTtl } from "../src/utils.js"
import { writeTurtleFile } from "../src/pipeline/write-turtle.js"

test("streamed Turtle output replaces the previous file only when complete", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "directory-turtle-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const file = path.join(root, "provenance.ttl")
    fs.writeFileSync(file, "previous")
    const statement = df.quad(df.namedNode("urn:entity"), df.namedNode("urn:name"), df.literal("Example"))
    const annotation = df.quad(df.blankNode(), df.namedNode("urn:reifies"), statement)
    function* interrupted() { yield annotation; throw new Error("interrupted") }

    await assert.rejects(writeTurtleFile(file, interrupted(), {}, { dedupe: false }), /interrupted/)
    assert.equal(fs.readFileSync(file, "utf8"), "previous")
    assert.deepEqual(fs.readdirSync(root), ["provenance.ttl"])

    await writeTurtleFile(file, [annotation], {}, { dedupe: false })
    assert.equal(parseTtl(fs.readFileSync(file, "utf8")).length, 1)
})

test("Turtle write failures preserve the previous file and remove temporary output", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "directory-turtle-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const file = path.join(root, "output.ttl")
    fs.writeFileSync(file, "previous")
    t.mock.method(fs, "writeFileSync", () => { throw new Error("disk full") })

    for (const value of ["short", "x".repeat(65536)]) {
        const quad = df.quad(df.namedNode("urn:entity"), df.namedNode("urn:name"), df.literal(value))
        await assert.rejects(writeTurtleFile(file, [quad], {}, { dedupe: false }), /disk full/)
        assert.equal(fs.readFileSync(file, "utf8"), "previous")
        assert.deepEqual(fs.readdirSync(root), ["output.ttl"])
    }
})
