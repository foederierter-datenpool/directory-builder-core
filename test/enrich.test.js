import { parseTtl, PATHS } from "@directory-builder/core/utils"
import { storeFromTurtles } from "@foerderfunke/sem-ops-utils"
import { Pipeline, validate } from "@directory-builder/core"
import { loadEnrichConfig, runEnrich } from "../src/pipeline/steps/enrich.js"
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
// entities in directory.ttl; only the tail-stripped lookup leaves a trace — the
// street that hit as `adjusted` in the cache, the full query string as a
// cdp:geocodedAs annotation in provenance.ttl. The second federate runs
// entirely from the committed cache — its network stub only throws.

const federation = `
@prefix :       <https://civic-data.de/pipeline#> .
@prefix schema: <http://schema.org/> .
@prefix ft:     <http://publications.europa.eu/resource/authority/file-type/> .

:federation a :Federation ; :hasSource :alphaSource .

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
    // resolve's output is the coordinate-free intermediate; enrich writes directory.ttl
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

const addressFixture = (name, entries = {}) => {
    const root = makeInstance(name, { federation, sources: { alpha } })
    const abs = (file) => path.join(root, file)
    fs.mkdirSync(path.dirname(abs(PATHS.geocache)), { recursive: true })
    fs.writeFileSync(abs(PATHS.geocache), JSON.stringify({ license: "test cache", entries }))
    fs.mkdirSync(path.dirname(abs(PATHS.resolved)), { recursive: true })
    return {
        root,
        cache: () => JSON.parse(fs.readFileSync(abs(PATHS.geocache), "utf8")),
        run: async (ttl) => {
            fs.writeFileSync(abs(PATHS.resolved), `@prefix schema: <${SCHEMA}> .\n${ttl}`)
            fs.writeFileSync(abs(PATHS.provenance), "")
            await runEnrich({ abs }, { geocodeClasses: [SCHEMA + "PostalAddress"], inheritance: [] },
                PATHS.resolved, PATHS.final, PATHS.provenance, PATHS.geocache)
        },
    }
}

test("geocache migrates legacy queries and reuses hits and misses across entity IDs", async (t) => {
    const hit = {
        query: { street: "Rathenower Straße 16, Haus H", postalcode: "10559", city: "Berlin", country: "DE" },
        adjusted: "Rathenower Straße 16", lat: "52.5298", lon: "13.3538",
    }
    const miss = { query: { street: "Unknown 1", postalcode: "10559", city: "Berlin" }, lat: null, lon: null }
    const fixture = addressFixture("geocache-migration", { "urn:old": hit, "urn:duplicate": hit, "urn:missing": miss })
    t.mock.method(globalThis, "fetch", async () => { throw new Error("cached address must not hit the network") })
    const addresses = `
<urn:new> a schema:PostalAddress ; schema:streetAddress "  RATHENOWER   STRAßE 16, HAUS H  " ;
    schema:postalCode "10559" ; schema:addressLocality "berlin" ; schema:addressCountry "de" .
<urn:another> a schema:PostalAddress ; schema:streetAddress "Rathenower Straße 16, Haus H" ;
    schema:postalCode "10559" ; schema:addressLocality "Berlin" ; schema:addressCountry "DE" .
<urn:new-miss> a schema:PostalAddress ; schema:streetAddress "Unknown 1" ;
    schema:postalCode "10559" ; schema:addressLocality "Berlin" .`
    await fixture.run(addresses)
    assert.deepEqual(geoOf(fixture.root).subjects, ["urn:another", "urn:new"])
    assert.deepEqual(geoOf(fixture.root).values, ["13.3538", "13.3538", "52.5298", "52.5298"])
    const cache = fixture.cache()
    assert.equal(cache.license, "test cache")
    assert.equal(Object.keys(cache.entries).length, 2, "duplicates collapse, including unused legacy aliases")
    assert.ok(Object.keys(cache.entries).every((key) => !key.startsWith("urn:")))
    assert.deepEqual(Object.values(cache.entries).find((entry) => entry.lat != null), hit)
    assert.deepEqual(Object.values(cache.entries).find((entry) => entry.lat == null), miss)
    const annotations = parseTtl(fs.readFileSync(path.join(fixture.root, PATHS.provenance), "utf8"))
        .filter((q) => q.predicate.value.endsWith("#geocodedAs"))
    assert.deepEqual(annotations.map((q) => q.subject.value).toSorted(), ["urn:another", "urn:new"])
    assert.ok(annotations.every((q) => q.object.value === "Rathenower Straße 16, 10559 Berlin, DE"))
    await fixture.run(addresses.replaceAll("urn:new", "urn:reminted"))
    assert.deepEqual(geoOf(fixture.root).subjects, ["urn:another", "urn:reminted"])
    assert.deepEqual(fixture.cache(), cache, "warm reruns leave the address cache unchanged")
    assert.equal(fs.existsSync(path.join(fixture.root, PATHS.registry)), false)
})

test("geocache shares cold lookups but distinguishes changed address components and skips incomplete addresses", async (t) => {
    const fixture = addressFixture("geocache-addresses")
    const queries = []
    t.mock.method(globalThis, "fetch", async (url) => {
        queries.push(Object.fromEntries(new URL(url).searchParams))
        return { ok: true, json: async () => [{ lat: String(queries.length), lon: "13" }] }
    })
    const address = (iri, street = "Schönhauser Allee 182", postcode = "10119", city = "Berlin", country = "DE") =>
        `<${iri}> a schema:PostalAddress ; schema:streetAddress "${street}" ; schema:postalCode "${postcode}" ;
            schema:addressLocality "${city}" ; schema:addressCountry "${country}" .`
    await fixture.run(address("urn:a") + address("urn:b", "Scho\u0308nhauser Allee 182"))
    assert.equal(queries.length, 1, "two entities with equivalent addresses share a single cold lookup")
    assert.deepEqual(geoOf(fixture.root).values, ["1", "1", "13", "13"])
    for (const args of [
        ["Schönhauser Allee 183"],
        ["Schönhauser Allee 182", "10120"],
        ["Schönhauser Allee 182", "10119", "Other city"],
        ["Schönhauser Allee 182", "10119", "Berlin", ""],
    ]) await fixture.run(address("urn:a", ...args))
    assert.equal(queries.length, 5, "each changed query requires its own lookup, even with the same IRI")
    assert.ok(geoOf(fixture.root).values.includes("5"), "the entity gets its current query's coordinates")
    assert.equal(Object.keys(fixture.cache().entries).length, 5, "previous addresses remain reusable")
    await fixture.run('<urn:a> a schema:PostalAddress ; schema:addressLocality "Berlin" .')
    assert.equal(queries.length, 5)
    assert.deepEqual(geoOf(fixture.root).subjects, [], "an incomplete address never receives stale coordinates")
})

test("geocache refreshes conflicting legacy results once per address", async (t) => {
    const query = { street: "Lehrter Straße 68", postalcode: "10557", city: "Berlin", country: "DE" }
    const fixture = addressFixture("geocache-conflict", {
        "urn:old-a": { query, lat: "52.5262801", lon: "13.3628471" },
        "urn:old-b": { query, lat: "52.5269425", lon: "13.3621018" },
        "urn:old-c": { query, lat: "52.5262801", lon: "13.3628471" },
    })
    const warnings = []
    t.mock.method(console, "warn", (message) => warnings.push(message))
    const fetch = t.mock.method(globalThis, "fetch", async () => ({
        ok: true, json: async () => [{ lat: "52.5269", lon: "13.3621" }],
    }))
    await fixture.run(["urn:new-a", "urn:new-b"].map((iri) => `
        <${iri}> a schema:PostalAddress ; schema:streetAddress "Lehrter Straße 68" ;
            schema:postalCode "10557" ; schema:addressLocality "Berlin" ; schema:addressCountry "DE" .`).join("\n"))
    assert.equal(fetch.mock.callCount(), 1)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /1 address\(es\).*conflicting/)
    assert.deepEqual(Object.values(fixture.cache().entries), [{ query, lat: "52.5269", lon: "13.3621" }])
    assert.deepEqual(geoOf(fixture.root).values, ["13.3621", "13.3621", "52.5269", "52.5269"])
})

const inheritanceFederation = `
@prefix :       <https://civic-data.de/pipeline#> .
@prefix schema: <http://schema.org/> .
@prefix ft:     <http://publications.europa.eu/resource/authority/file-type/> .

:federation a :Federation ; :hasSource :alphaSource .

:facilitySchema a :TargetSchema ; :targetClass schema:Place .
:serviceSchema  a :TargetSchema ; :targetClass schema:Service .
:t-id a :TargetField ; :targetPredicate schema:identifier .

:alphaSource a :Source ; :format ft:JSON ; :hasField :alpha-id .
:alpha-id a :SourceField ; :fieldPath "id" ; :iriSource true .
:alpha-mapping a :Mapping ; :fromSource :alphaSource ; :toTarget :facilitySchema ;
    :hasFieldMapping [ :from :alpha-id ; :to :t-id ] .

:match a :MatchRule ; :forTarget :facilitySchema ;
    :targetNamespace "urn:test:" ; :mintedSubjectPrefix "place-" .

:enrich a :EnrichRule ;
    :inherit :facilityToServiceInheritance .

:facilityToServiceInheritance a :InheritanceRule ;
    :from :facilitySchema ;
    :to :serviceSchema ;
    :through schema:provider ;
    :on schema:audience, schema:openingHours .
`

test("enrich inherits fallback values and records their provider provenance", async () => {
    const root = makeInstance("inherit", {
        federation: inheritanceFederation,
        sources: { alpha: [{ id: "unused" }] },
    })
    assert.deepEqual(await validate(root), [])

    const resolvedTtl = `
@prefix schema: <http://schema.org/> .

<urn:facility> a schema:Place ;
    schema:audience "Adults" ;
    schema:openingHours "Mo-Fr 09:00-17:00" .
<urn:service-a> a schema:Service ; schema:provider <urn:facility> .
<urn:service-b> a schema:Service ;
    schema:provider <urn:facility> ;
    schema:audience "Direct audience" .

<urn:other-provider> a schema:Organization ; schema:audience "Not inherited" .
<urn:service-c> a schema:Service ; schema:provider <urn:other-provider> .
`
    const abs = (file) => path.join(root, file)
    fs.mkdirSync(path.dirname(abs(PATHS.resolved)), { recursive: true })
    fs.writeFileSync(abs(PATHS.resolved), resolvedTtl)
    fs.writeFileSync(abs(PATHS.provenance), "")

    const config = await loadEnrichConfig(storeFromTurtles([inheritanceFederation]))
    await runEnrich({ abs }, config, PATHS.resolved, PATHS.final, PATHS.provenance, PATHS.geocache)

    const final = parseTtl(fs.readFileSync(abs(PATHS.final), "utf8"))
    const values = (subject, predicate) => final
        .filter((quad) => quad.subject.value === subject && quad.predicate.value === SCHEMA + predicate)
        .map((quad) => quad.object.value)

    assert.deepEqual(values("urn:service-a", "audience"), ["Adults"])
    assert.deepEqual(values("urn:service-a", "openingHours"), ["Mo-Fr 09:00-17:00"])
    assert.deepEqual(values("urn:service-b", "audience"), ["Direct audience"], "direct values win")
    assert.deepEqual(values("urn:service-b", "openingHours"), ["Mo-Fr 09:00-17:00"])
    assert.deepEqual(values("urn:service-c", "audience"), [], "the configured source class is enforced")
    assert.equal(fs.existsSync(abs(PATHS.geocache)), false, "inheritance alone creates no geocache")

    const provenance = parseTtl(fs.readFileSync(abs(PATHS.provenance), "utf8"))
    const derivedFrom = provenance.filter((quad) => quad.predicate.value === "http://www.w3.org/ns/prov#wasDerivedFrom")
    assert.equal(derivedFrom.length, 3)
    assert.ok(derivedFrom.every((quad) => quad.object.value === "urn:facility"))
    const generatedBy = provenance.filter((quad) => quad.predicate.value === "http://www.w3.org/ns/prov#wasGeneratedBy")
    assert.equal(generatedBy.length, 3)
    assert.ok(generatedBy.every((quad) => quad.object.value === "https://civic-data.de/pipeline#enrichStep"))
    const appliedRule = provenance.filter((quad) => quad.predicate.value === "https://civic-data.de/pipeline#appliedRule")
    assert.equal(appliedRule.length, 3)
    assert.ok(appliedRule.every((quad) =>
        quad.object.value === "https://civic-data.de/pipeline#facilityToServiceInheritance"))
    assert.equal(provenance.filter((quad) =>
        quad.predicate.value === "http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies"
        && quad.object.termType === "Quad").length, 3)
})
