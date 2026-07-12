import { parseTtl, PATHS } from "@directory-builder/core/utils"
import { Pipeline, validate } from "@directory-builder/core"
import { makeInstance } from "./helpers/instance.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"
import fs from "fs"

// ---- The enrich step: geocoding via Nominatim, through the committed cache --
// One source, two address-carrying records (one with a sub-address tail), an
// :EnrichRule on their schema. The first federate geocodes through structured
// Nominatim queries (stubbed): the plain street hits directly, the suffixed one
// misses and hits on the tail-stripped retry. Coordinates land directly on the
// entities in final.ttl; only the tail-stripped lookup leaves a trace — the
// street that hit as `adjusted` in the cache, the full query string as a
// cdp:geocodedAs annotation in provenance.ttl. The second federate runs
// entirely from the committed cache — its network stub only throws.

const federation = `
@prefix :       <https://civic-data.de/pipeline#> .
@prefix schema: <http://schema.org/> .
@prefix ft:     <http://publications.europa.eu/resource/authority/file-type/> .

:federation a :Federation ; :hasSource :alphaSource ; :hasEnrichRule :enrich .

:placeSchema a :TargetSchema ; :targetClass schema:PostalAddress .
:t-id     a :TargetField ; :targetPredicate schema:identifier .
:t-street a :TargetField ; :targetPredicate schema:streetAddress .
:t-plz    a :TargetField ; :targetPredicate schema:postalCode .
:t-city   a :TargetField ; :targetPredicate schema:addressLocality .

:alphaSource a :Source ; :format ft:JSON ; :hasField :alpha-id, :alpha-street, :alpha-plz, :alpha-city .
:alpha-id     a :SourceField ; :fieldPath "id" ; :iriSource true .
:alpha-street a :SourceField ; :fieldPath "street" .
:alpha-plz    a :SourceField ; :fieldPath "plz" .
:alpha-city   a :SourceField ; :fieldPath "city" .

:alpha-mapping a :Mapping ; :fromSource :alphaSource ; :toTarget :placeSchema ;
    :hasFieldMapping [ :from :alpha-id ; :to :t-id ] , [ :from :alpha-street ; :to :t-street ] ,
        [ :from :alpha-plz ; :to :t-plz ] , [ :from :alpha-city ; :to :t-city ] .

:match a :MatchRule ; :forTarget :placeSchema ; :targetNamespace "urn:test:" ; :mintedSubjectPrefix "addr-" .

:enrich a :EnrichRule ; :geocode :placeSchema .
`

const alpha = [
    { id: "a1", street: "Badstraße 10", plz: "13357", city: "Berlin" },
    { id: "a2", street: "Rathenower Straße 16, Haus H", plz: "10559", city: "Berlin" },
]

const SCHEMA = "http://schema.org/"
const geoOf = (root) => {
    const final = parseTtl(fs.readFileSync(path.join(root, PATHS.final), "utf8"))
    const coords = final.filter((q) => [SCHEMA + "latitude", SCHEMA + "longitude"].includes(q.predicate.value))
    return {
        subjects: [...new Set(coords.map((q) => q.subject.value))].toSorted(),
        values: coords.map((q) => q.object.value).toSorted(),
    }
}

test("enrich geocodes via Nominatim with a tail-stripped retry, cached for offline reruns", async (t) => {
    const root = makeInstance("enrich", { federation, sources: { alpha } })
    assert.deepEqual(await validate(root), [])
    const pipeline = new Pipeline({ root })
    await pipeline.ingest()

    // federate 1 — cold cache: the full "Haus H" street misses, its retry hits
    const streets = []
    t.mock.method(globalThis, "fetch", async (url) => {
        const street = new URL(url).searchParams.get("street")
        streets.push(street)
        return { ok: true, json: async () => street.includes("Haus") ? [] : [{ lat: "52.5490", lon: "13.3877" }] }
    })
    await pipeline.federate()
    assert.deepEqual(streets.toSorted(), ["Badstraße 10", "Rathenower Straße 16", "Rathenower Straße 16, Haus H"])
    // resolve's output is the coordinate-free intermediate; enrich writes final.ttl
    assert.ok(!fs.readFileSync(path.join(root, PATHS.resolved), "utf8").includes("latitude"))
    const cold = geoOf(root)
    assert.equal(cold.subjects.length, 2)
    for (const s of cold.subjects) assert.match(s, /^urn:test:addr-/, "coordinates sit directly on the entity")
    assert.deepEqual(cold.values, ["13.3877", "13.3877", "52.5490", "52.5490"])

    // the cache names its endpoint, and `adjusted` appears only on the entry
    // whose lookup needed the stripped street
    const cache = JSON.parse(fs.readFileSync(path.join(root, PATHS.geocache), "utf8"))
    assert.equal(cache.endpoint, "https://nominatim.openstreetmap.org/search")
    const entries = Object.values(cache.entries)
    assert.equal(entries.find((e) => e.query.street === "Badstraße 10").adjusted, undefined)
    assert.equal(entries.find((e) => e.query.street.includes("Haus")).adjusted, "Rathenower Straße 16")

    // ... and only the tail-stripped lookup is annotated in provenance.ttl,
    // with the full query string it sent
    const prov = parseTtl(fs.readFileSync(path.join(root, PATHS.provenance), "utf8"))
    const geocodedAs = prov.filter((q) => q.predicate.value === "https://civic-data.de/pipeline#geocodedAs")
    assert.equal(geocodedAs.length, 1)
    assert.match(geocodedAs[0].subject.value, /^urn:test:addr-/)
    assert.equal(geocodedAs[0].object.value, "Rathenower Straße 16, 10559 Berlin")

    // federate 2 — warm cache: no network at all
    t.mock.method(globalThis, "fetch", async () => { throw new Error("network hit despite warm cache") })
    await pipeline.federate()
    assert.deepEqual(geoOf(root), cold)
})
