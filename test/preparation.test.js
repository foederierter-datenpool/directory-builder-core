import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { runPreparation } from "../src/pipeline/steps/preparation.js"
import { CDP, NAMESPACES, parseTtl, PATHS } from "../src/utils.js"

test("preparation selects lifted records with the most matching fields", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "directory-preparation-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const abs = file => path.join(root, file)
    fs.mkdirSync(abs(PATHS.lifted("alpha")), { recursive: true })
    fs.mkdirSync(path.dirname(abs(PATHS.extracted("alpha"))), { recursive: true })
    fs.writeFileSync(abs(path.join(PATHS.lifted("alpha"), "records.ttl")), `
        @prefix xyz: <${NAMESPACES.xyz}> .
        <urn:raw:a> xyz:name "Alpha" ; xyz:city "Berlin" ; xyz:street "Raw A" .
        <urn:raw:b> xyz:name "Alpha" ; xyz:city "Hamburg" ; xyz:street "Raw B" .
    `)
    fs.writeFileSync(abs(PATHS.extracted("alpha")), `
        @prefix cdp: <${CDP}> .
        @prefix xyz: <${NAMESPACES.xyz}> .
        <urn:best> cdp:targetSchema <urn:schema> ;
            xyz:name "Alpha" ; xyz:city "Berlin" ; xyz:street "Clean" .
        <urn:tie> cdp:targetSchema <urn:schema> ;
            xyz:name "Alpha" ; xyz:street "Clean" .
    `)

    await runPreparation({ abs, quads: [] }, [`${CDP}alphaSource`])

    const quads = parseTtl(fs.readFileSync(abs(PATHS.preparation("alpha")), "utf8"))
    const prepared = quads.filter(q => q.predicate.value === `${CDP}prepared`)
    assert.deepEqual(prepared.map(q => q.subject.value), ["urn:best"])
    assert.equal(quads.find(q => q.predicate.value === `${CDP}rawValue`)?.object.value, "Raw A")
})
