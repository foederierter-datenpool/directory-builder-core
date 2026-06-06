import { CDP, objectsOf, parseTtl, PATHS, sourceName } from "@directory-builder/core/utils"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"
import fs from "fs"

const INSTANCE_ROOT = path.join(import.meta.dirname, "../example")

// The instance contract: every :hasSource in federation.ttl has its
// sources/<name>/ folder with fetch.js + clean.sparql - and no folder
// exists that the federation doesn't declare.
test("federation.ttl sources and sources/ folder is in sync", () => {
    const federationTtl = fs.readFileSync(path.join(INSTANCE_ROOT, PATHS.federation), "utf8")
    const declared = objectsOf(parseTtl(federationTtl), `${CDP}hasSource`).map(sourceName)
    // direction 1
    for (const name of declared) {
        for (const file of [PATHS.fetchScript(name), PATHS.cleanQuery(name)]) {
            assert.ok(fs.existsSync(path.join(INSTANCE_ROOT, file)), `${file} exists`)
        }
    }
    // direction 2
    const folders = fs.readdirSync(path.join(INSTANCE_ROOT, "sources"), { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name)
    assert.deepEqual(folders.toSorted(), declared.toSorted())
})
