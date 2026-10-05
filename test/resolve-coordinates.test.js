import { runResolve } from "../src/pipeline/steps/resolve.js"
import { HAS_MEMBER, MATCH_GRAPH } from "../src/pipeline/steps/match.js"
import { MAPPED_GRAPH } from "../src/pipeline/steps/map.js"
import { MERGED_GRAPH } from "../src/pipeline/steps/merge.js"
import { CDP, NAMESPACES, parseTtl } from "../src/utils.js"
import { DataFactory, Store } from "n3"
import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const df = DataFactory
const lat = df.namedNode(`${NAMESPACES.schema}latitude`)
const lon = df.namedNode(`${NAMESPACES.schema}longitude`)
const literal = value => df.literal(value)

test("resolve keeps coordinates from one source address and leaves ambiguous ones for geocoding", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-coordinates-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const store = new Store()
    const defStore = new Store(parseTtl(`
        @prefix : <${CDP}> .
        :match a :MatchRule ; :targetNamespace "urn:test:" .
    `))
    const add = (minted, member, latitude, longitude) => {
        const m = df.namedNode(`urn:test:${minted}`)
        const source = df.namedNode(`urn:source:${member}`)
        store.addQuad(m, HAS_MEMBER, source, MATCH_GRAPH)
        for (const [predicate, values] of [[lat, latitude], [lon, longitude]]) {
            for (const value of values) {
                store.addQuad(source, predicate, literal(value), MAPPED_GRAPH)
                store.addQuad(m, predicate, literal(value), MERGED_GRAPH)
            }
        }
    }
    // Independently choosing the longest latitude and longitude would combine
    // the first member's latitude with the second member's longitude.
    add("paired", "a", ["52.5000"], ["13.4"])
    add("paired", "b", ["52.6"], ["13.4000"])
    // Two pairs on a single address IRI have lost their association in RDF.
    add("ambiguous", "c", ["52.5", "52.6"], ["13.4", "13.5"])

    await runResolve({ store, defStore, abs: p => path.join(root, p) }, "resolved.ttl")
    const result = new Store(parseTtl(fs.readFileSync(path.join(root, "resolved.ttl"), "utf8")))
    const values = (entity, predicate) => result.getQuads(df.namedNode(`urn:test:${entity}`), predicate, null, null)
        .map(q => q.object.value)
    assert.deepEqual(values("paired", lat), ["52.5000"])
    assert.deepEqual(values("paired", lon), ["13.4"])
    assert.deepEqual(values("ambiguous", lat), [])
    assert.deepEqual(values("ambiguous", lon), [])
})
