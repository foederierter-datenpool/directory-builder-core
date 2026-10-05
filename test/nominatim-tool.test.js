import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

test("local importer bounds its cache while preserving version checks, paths and remaining arguments", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nominatim-wrapper-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.writeFileSync(path.join(root, "osm2pgsql"), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o755 })
    const run = (args, cache = "2048") => spawnSync("bash", [
        path.join(import.meta.dirname, "../tools/nominatim/osm2pgsql.sh"), ...args,
    ], { encoding: "utf8", env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, OSM2PGSQL_CACHE_MB: cache } })

    const importArgs = ["--create", "--cache", "8192", "--style", "/a path/address.lua", "/data/germany.osm.pbf"]
    const imported = run(importArgs)
    assert.equal(imported.status, 0, imported.stderr)
    assert.deepEqual(JSON.parse(imported.stdout), ["--create", "--cache", "2048", ...importArgs.slice(3)])
    assert.deepEqual(JSON.parse(run(["--version"]).stdout), ["--version"])
    assert.deepEqual(JSON.parse(run(["--cache=8192", "--slim"], "1024").stdout), ["--cache=1024", "--slim"])
    for (const cache of ["0", "-1", "2GB", "1.5"])
        assert.equal(run(importArgs, cache).status, 1, `reject invalid cache ${cache}`)
    assert.equal(run(["--cache"]).status, 1, "missing upstream value fails before invoking the importer")
})
