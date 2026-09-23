import { runExtract } from "../src/pipeline/steps/extract.js"
import { PATHS, parseTtl } from "../src/utils.js"
import { strict as assert } from "assert"
import { test } from "node:test"
import path from "path"
import fs from "fs"

// runExtract reads lifted Turtle off disk, so a fixture can be written straight
// into data/ingest/lifted/ — no lift step, no JVM, no jar.
const stage = (name, liftedTtl, extractQuery) => {
    const root = path.join(import.meta.dirname, "tmp", name)
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(path.join(root, PATHS.lifted("big")), { recursive: true })
    fs.writeFileSync(path.join(root, PATHS.lifted("big"), "all.ttl"), liftedTtl)
    fs.mkdirSync(path.join(root, `sources/big`), { recursive: true })
    fs.writeFileSync(path.join(root, PATHS.extractQuery("big")), extractQuery)
    return { root, abs: (p) => path.join(root, p) }
}

const liftedWith = (n) => {
    const lines = ["PREFIX xyz: <http://sparql.xyz/facade-x/data/>"]
    for (let i = 0; i < n; i++) lines.push(`<http://e/${i}> xyz:id "${i}" .`)
    return lines.join("\n") + "\n"
}

const PASSTHROUGH = `
PREFIX xyz: <http://sparql.xyz/facade-x/data/>
CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }
`

// Regression: the per-file quads were appended with push(...quads). The spread
// passes every quad as its own argument, so one lifted file yielding enough of
// them blew V8's argument limit and killed the run with a RangeError — two
// steps away from the source responsible, with no partial output.
//
// The threshold is well over 100k, so the fixture has to be genuinely large;
// there is no smaller input that exercises it.
test("a lifted file large enough to exceed V8's argument limit still extracts", async () => {
    const COUNT = 160_000
    const { abs } = stage("extract-large", liftedWith(COUNT), PASSTHROUGH)

    await runExtract({ abs, quads: [] }, "https://civic-data.de/pipeline#bigSource")

    const written = parseTtl(fs.readFileSync(abs(PATHS.extracted("big")), "utf8"))
    assert.equal(written.length, COUNT, "every quad survives, none lost to batching")
})

test("a small lifted file is unaffected", async () => {
    const { abs } = stage("extract-small", liftedWith(3), PASSTHROUGH)
    await runExtract({ abs, quads: [] }, "https://civic-data.de/pipeline#bigSource")
    assert.equal(parseTtl(fs.readFileSync(abs(PATHS.extracted("big")), "utf8")).length, 3)
})
