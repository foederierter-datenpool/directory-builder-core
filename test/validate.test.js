import { validate } from "@directory-builder/core"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"

const INSTANCE_ROOT = path.join(import.meta.dirname, "../example")

// The example instance satisfies the contract validate() enforces: every
// :hasSource in federation.ttl has its sources/<name>/ folder with fetch.js
// + clean.sparql, and no folder exists that the federation doesn't declare.
test("validate() finds no problems in the example instance", () => {
    assert.deepEqual(validate(INSTANCE_ROOT), [])
})
