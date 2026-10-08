import { validate } from "@directory-builder/core"
import { buildValidator, turtleToDataset } from "@foerderfunke/sem-ops-utils"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"
import fs from "node:fs"

const INSTANCE_ROOT = path.join(import.meta.dirname, "../example")

// The example instance satisfies the contract validate() enforces: every
// :hasSource in federation.ttl has its sources/<name>/ folder with fetch.js
// + extract.sparql, no folder exists that the federation doesn't declare, and
// federation.ttl conforms to the engine's SHACL shape.
test("validate() finds no problems in the example instance", async () => {
    assert.deepEqual(await validate(INSTANCE_ROOT), [])
})

test("typeDerivation is optional and accepts exactly one recognized IRI when present", async () => {
    const validator = buildValidator(fs.readFileSync(new URL("../src/validate/federation.shacl.ttl", import.meta.url), "utf8"))
    const ttl = fs.readFileSync(path.join(INSTANCE_ROOT, "config/federation.ttl"), "utf8")
        + "\n:testField a :TargetField ; :targetPredicate schema:name ."
    for (const [value, valid] of [
        ["", true], [":adopted", true], [":overridden", true], [":local", true],
        [":unknown", false], ['"adopted"', false], [":adopted, :local", false],
    ]) {
        const dataset = turtleToDataset(ttl + (value ? `\n:testField :typeDerivation ${value} .` : ""))
        const report = await validator.validate({ dataset })
        assert.equal(report.results.length === 0, valid, value || "omitted")
    }
})

test("webappChunking is optional and accepts a single boolean", async () => {
    const validator = buildValidator(fs.readFileSync(new URL("../src/validate/federation.shacl.ttl", import.meta.url), "utf8"))
    const ttl = fs.readFileSync(path.join(INSTANCE_ROOT, "config/federation.ttl"), "utf8")
    for (const [value, valid] of [["", true], ["true", true], ["false", true], ['"true"', false], ["true, false", false]]) {
        const report = await validator.validate({ dataset: turtleToDataset(ttl + (value ? `\n:federation :webappChunking ${value} .` : "")) })
        assert.equal(report.results.length === 0, valid, value || "omitted")
    }
})
