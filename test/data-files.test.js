import { instanceDataFiles } from "../webapp/vite.js"
import { buildDataFileTree, encodedPath } from "../webapp/src/dataFiles.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"

const exampleRoot = path.join(import.meta.dirname, "../example")

test("the webapp indexes public data artifacts and builds a directory tree", () => {
    const files = instanceDataFiles(exampleRoot)
    assert.ok(files.includes("data/directory.ttl"))
    assert.ok(files.every((file) => !file.split("/").some((part) => part.startsWith("."))))

    const tree = buildDataFileTree([
        "data/catalog.ttl",
        "data/directory.ttl",
        "data/provenance.ttl",
        "data/ingest/raw/source/data file.json",
    ])
    assert.deepEqual([...tree.directories.keys()], ["ingest"])
    assert.deepEqual(tree.files.map((file) => file.name),
        ["catalog.ttl", "directory.ttl", "provenance.ttl"])
    assert.equal(encodedPath("data/ingest/raw/source/data file.json"),
        "data/ingest/raw/source/data%20file.json")
})
