import { instanceDataFiles } from "../webapp/vite.js"
import { buildDataFileTree, encodedPath } from "../webapp/src/dataFiles.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"
import os from "os"
import fs from "fs"

// Built here rather than read from example/, whose data/ is generated output and
// gitignored — pointing at it made this test pass only on a machine where the
// example had already been run, and fail in any fresh checkout.
const instanceWithDataFiles = (files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "datafiles-"))
    for (const file of files) {
        fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
        fs.writeFileSync(path.join(root, file), "")
    }
    return root
}

test("instanceDataFiles indexes the public data artifacts", () => {
    const root = instanceWithDataFiles([
        "data/directory.ttl",
        "data/catalog.ttl",
        "data/ingest/raw/source/records.json",
    ])
    const files = instanceDataFiles(root)
    assert.deepEqual(files, ["data/catalog.ttl", "data/directory.ttl", "data/ingest/raw/source/records.json"],
        "sorted, and nested files carry their full public path")
})

test("dot-prefixed files and directories stay out of the index", () => {
    const root = instanceWithDataFiles([
        "data/directory.ttl",
        "data/.hidden.ttl",
        "data/.cache/inner.ttl",
    ])
    const files = instanceDataFiles(root)
    assert.deepEqual(files, ["data/directory.ttl"])
    assert.ok(files.every((file) => !file.split("/").some((part) => part.startsWith("."))))
})

test("an instance with no data directory indexes nothing", () => {
    assert.deepEqual(instanceDataFiles(fs.mkdtempSync(path.join(os.tmpdir(), "datafiles-empty-"))), [])
})

test("the directory tree separates nested directories from top-level files", () => {
    const tree = buildDataFileTree([
        "data/catalog.ttl",
        "data/directory.ttl",
        "data/provenance.ttl",
        "data/ingest/raw/source/data file.json",
    ])
    assert.deepEqual([...tree.directories.keys()], ["ingest"])
    assert.deepEqual(tree.files.map((file) => file.name), ["catalog.ttl", "directory.ttl", "provenance.ttl"])
})

test("a path with a space is encoded for the browser", () => {
    assert.equal(encodedPath("data/ingest/raw/source/data file.json"),
        "data/ingest/raw/source/data%20file.json")
})
