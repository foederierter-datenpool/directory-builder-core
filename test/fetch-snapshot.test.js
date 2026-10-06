import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { runFetch } from "../src/pipeline/steps/fetch.js"

test("a failed fetch keeps the last complete raw snapshot", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "directory-fetch-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const raw = path.join(root, "data/ingest/raw/alpha")
    const script = path.join(root, "sources/alpha/fetch.js")
    fs.mkdirSync(raw, { recursive: true })
    fs.mkdirSync(path.dirname(script), { recursive: true })
    fs.writeFileSync(path.join(raw, "old.json"), "old")
    const ctx = { root, abs: relative => path.join(root, relative) }
    const source = { name: "alpha", fetchUrl: "https://example.test", paramsJson: "{}" }

    fs.writeFileSync(script, 'require("fs").writeFileSync(process.argv[2] + "/partial.json", "partial"); process.exit(1)')
    await assert.rejects(runFetch(ctx, source), /Exit 1/)
    assert.deepEqual(fs.readdirSync(raw), ["old.json"])

    fs.writeFileSync(script, 'require("fs").writeFileSync(process.argv[2] + "/new.json", "new")')
    await runFetch(ctx, source)
    assert.deepEqual(fs.readdirSync(raw), ["new.json"])
})
