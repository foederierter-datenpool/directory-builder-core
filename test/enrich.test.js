import { parseTtl, PATHS } from "@directory-builder/core/utils"
import { storeFromTurtles } from "@foerderfunke/sem-ops-utils"
import { Pipeline, validate } from "@directory-builder/core"
import { loadEnrichConfig, runEnrich } from "../src/pipeline/steps/enrich.js"
import { makeInstance } from "./helpers/instance.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import path from "path"
import fs from "fs"

const PUBLIC_ENDPOINT = "https://nominatim.openstreetmap.org/search"
const geocodeEnvironment = (t, values = {}) => {
    for (const [key, value] of Object.entries({
        GEOCODE_ENDPOINT: PUBLIC_ENDPOINT, GEOCODE_DELAY_MS: undefined,
        GEOCODE_CACHE_ONLY: undefined, GEOCODE_DATASET: undefined,
        GEOCODE_RETRY_MISSES: undefined, ...values,
    })) {
        const previous = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
        t.after(() => {
            if (previous === undefined) delete process.env[key]
            else process.env[key] = previous
        })
    }
}

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
    geocodeEnvironment(t)
    const root = makeInstance("enrich", { federation, sources: { alpha } })
    assert.deepEqual(await validate(root), [])
    const pipeline = new Pipeline({ root })
    await pipeline.ingest()

    // federate 1 — cold cache: the full "Haus H" street misses, its retry hits
    const streets = []
    const fetch = t.mock.method(globalThis, "fetch", async (url) => {
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
    const coordinateQuads = parseTtl(fs.readFileSync(path.join(root, PATHS.final), "utf8"))
        .filter((q) => [SCHEMA + "latitude", SCHEMA + "longitude"].includes(q.predicate.value))
    assert.ok(coordinateQuads.every((q) => q.object.datatype.value === "http://www.w3.org/2001/XMLSchema#double"))

    // each entry names its endpoint, and `adjusted` appears only on the entry
    // whose lookup needed the stripped street
    const cache = JSON.parse(fs.readFileSync(path.join(root, PATHS.geocache), "utf8"))
    assert.equal(cache.endpoint, undefined)
    const entries = Object.values(cache.entries)
    assert.ok(entries.every((entry) => entry.endpoint === PUBLIC_ENDPOINT))
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
    fetch.mock.mockImplementation(async () => { throw new Error("network hit despite warm cache") })
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
    geocodeEnvironment(t)
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
    assert.deepEqual(Object.values(cache.entries).find((entry) => entry.lat != null), { ...hit, endpoint: PUBLIC_ENDPOINT })
    assert.deepEqual(Object.values(cache.entries).find((entry) => entry.lat == null), { ...miss, endpoint: PUBLIC_ENDPOINT })
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
    geocodeEnvironment(t)
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
    geocodeEnvironment(t)
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
    assert.deepEqual(Object.values(fixture.cache().entries), [{ query, lat: "52.5269", lon: "13.3621",
        endpoint: "https://nominatim.openstreetmap.org/search" }])
    assert.deepEqual(geoOf(fixture.root).values, ["13.3621", "13.3621", "52.5269", "52.5269"])
})

const postalAddress = (id, street = `Teststraße ${id}`) => `
<urn:address-${id}> a schema:PostalAddress ; schema:streetAddress "${street}" ;
    schema:postalCode "10115" ; schema:addressLocality "Berlin" ; schema:addressCountry "DE" .`

test("geocoding settings have no effect without an instance geocode rule", async (t) => {
    geocodeEnvironment(t, { GEOCODE_ENDPOINT: "not a URL", GEOCODE_DELAY_MS: "invalid", GEOCODE_CACHE_ONLY: "invalid" })
    const fixture = addressFixture("geocache-opt-in")
    const original = fixture.cache()
    const abs = (file) => path.join(fixture.root, file)
    fs.writeFileSync(abs(PATHS.resolved), `@prefix schema: <${SCHEMA}> .\n${postalAddress(1)}`)
    t.mock.method(globalThis, "fetch", async () => { throw new Error("geocoding is not enabled") })
    await runEnrich({ abs }, { geocodeClasses: [], inheritance: [] },
        PATHS.resolved, PATHS.final, PATHS.provenance, PATHS.geocache)
    assert.deepEqual(geoOf(fixture.root).subjects, [])
    assert.deepEqual(fixture.cache(), original)
})

test("source coordinate pairs bypass Nominatim and the geocache", async (t) => {
    geocodeEnvironment(t, { GEOCODE_CACHE_ONLY: "true" })
    const root = makeInstance("source-coordinates", { federation, sources: { alpha } })
    const abs = (file) => path.join(root, file)
    fs.mkdirSync(path.dirname(abs(PATHS.resolved)), { recursive: true })
    fs.writeFileSync(abs(PATHS.resolved), `
@prefix schema: <http://schema.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<urn:address> a schema:PostalAddress ;
    schema:streetAddress "Badstraße 10" ;
    schema:postalCode "13357" ;
    schema:addressLocality "Berlin" ;
    schema:latitude "52.55"^^xsd:double ;
    schema:longitude "13.38"^^xsd:double .
`)
    fs.writeFileSync(abs(PATHS.provenance), "")
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("no lookup expected") })
    const config = { geocodeClasses: [SCHEMA + "PostalAddress"], inheritance: [] }
    await runEnrich({ abs }, config, PATHS.resolved, PATHS.final, PATHS.provenance, PATHS.geocache)
    assert.equal(fetch.mock.callCount(), 0)
    assert.equal(fs.existsSync(abs(PATHS.geocache)), false)
    assert.deepEqual(geoOf(root), { subjects: ["urn:address"], values: ["13.38", "52.55"] })

    fs.writeFileSync(abs(PATHS.resolved), fs.readFileSync(abs(PATHS.resolved), "utf8")
        .replace('    schema:longitude "13.38"^^xsd:double .', "."))
    await assert.rejects(
        runEnrich({ abs }, config, PATHS.resolved, PATHS.final, PATHS.provenance, PATHS.geocache),
        /invalid source coordinate pair/,
    )
})

test("cache-only mode accepts cached misses and legacy hits without changing their origin", async (t) => {
    geocodeEnvironment(t, { GEOCODE_ENDPOINT: "http://127.0.0.1:8088/search", GEOCODE_CACHE_ONLY: "true",
        GEOCODE_RETRY_MISSES: "true" })
    const query = { street: "Teststraße 1", postalcode: "10115", city: "Berlin", country: "DE" }
    const hit = { query, lat: "52.5", lon: "13.4" }
    const miss = { query: { ...query, street: "Teststraße 2" }, lat: null, lon: null }
    const fixture = addressFixture("geocache-offline-legacy", { old: hit, missing: miss })
    const origin = "http://legacy-geocoder/search"
    fs.writeFileSync(path.join(fixture.root, PATHS.geocache), JSON.stringify({ ...fixture.cache(), endpoint: origin }))
    t.mock.method(globalThis, "fetch", async () => { throw new Error("no network") })
    await fixture.run(postalAddress(1) + postalAddress(2) + '<urn:incomplete> a schema:PostalAddress .')
    assert.deepEqual(geoOf(fixture.root).subjects, ["urn:address-1"])
    assert.equal(fixture.cache().endpoint, undefined)
    assert.ok(Object.values(fixture.cache().entries).every((entry) => entry.endpoint === origin))
})

test("default geocoding discovers local Nominatim once and needs no service for cached coordinates", async (t) => {
    geocodeEnvironment(t, { GEOCODE_ENDPOINT: undefined, GEOCODE_DATASET: "berlin" })
    const fixture = addressFixture("geocache-auto-local")
    const requests = []
    const fetch = t.mock.method(globalThis, "fetch", async (url) => {
        requests.push(new URL(url).pathname)
        assert.equal(new URL(url).origin, "http://127.0.0.1:8088")
        return { ok: true, json: async () => new URL(url).pathname === "/status"
            ? { status: 0, data_updated: "2026-10-02T19:38:48+00:00" } : [{ lat: "52.5", lon: "13.4" }] }
    })
    const addresses = postalAddress(1) + postalAddress(2) + postalAddress(3, "Teststraße 1")
    await fixture.run(addresses)
    assert.deepEqual(requests, ["/status", "/search", "/search"])
    assert.equal(geoOf(fixture.root).subjects.length, 3)
    assert.ok(Object.values(fixture.cache().entries).every((entry) =>
        entry.endpoint === "http://127.0.0.1:8088/search" && entry.dataset === "berlin"
        && entry.dataUpdated === "2026-10-02T19:38:48+00:00"))
    fetch.mock.mockImplementation(async () => { throw new Error("cached coordinates need no health probe") })
    await fixture.run(addresses)
    assert.equal(fetch.mock.callCount(), 3)
})

for (const failure of ["unavailable", "not-ready", "lookup-failure", "malformed-result"]) {
    test(`automatic public fallback is throttled after local ${failure}`, async (t) => {
        geocodeEnvironment(t, { GEOCODE_ENDPOINT: undefined, GEOCODE_DELAY_MS: "0", GEOCODE_DATASET: "berlin" })
        const delays = []
        t.mock.method(globalThis, "setTimeout", (callback, delay) => {
            delays.push(delay)
            return setImmediate(callback)
        })
        const fixture = addressFixture(`geocache-fallback-${failure}`)
        let probes = 0, local = 0, publicRequests = 0
        t.mock.method(globalThis, "fetch", async (url) => {
            const { hostname, pathname } = new URL(url)
            if (hostname === "nominatim.openstreetmap.org") {
                publicRequests++
                return { ok: true, json: async () => [{ lat: "52.5", lon: "13.4" }] }
            }
            assert.equal(hostname, "127.0.0.1")
            if (pathname === "/status") {
                probes++
                if (failure === "unavailable") throw new Error("connection refused")
                return { ok: true, json: async () => ({ status: failure === "not-ready" ? 700 : 0 }) }
            }
            local++
            // Complete one local lookup before the service fails.
            if (local === 1) return { ok: true, json: async () => [{ lat: "52.6", lon: "13.5" }] }
            if (failure === "malformed-result") return { ok: true, json: async () => ({ error: "broken" }) }
            throw new Error("connection reset")
        })
        const midRun = failure === "lookup-failure" || failure === "malformed-result"
        await fixture.run(postalAddress(1) + postalAddress(2) + (midRun ? postalAddress(3) : ""))
        assert.deepEqual(delays, [1100], "the local zero delay cannot disable public throttling")
        assert.equal(publicRequests, 2)
        assert.equal(probes, 1)
        assert.equal(local, midRun ? 2 : 0)
        const publicEntries = Object.values(fixture.cache().entries).filter((entry) => entry.endpoint === PUBLIC_ENDPOINT)
        assert.equal(publicEntries.length, 2)
        assert.ok(publicEntries.every((entry) => entry.dataset === undefined && entry.dataUpdated === undefined),
            "local dataset provenance must not be attached to fallback results")
    })
}

test("cached misses retry after endpoint or dataset changes, while successful coordinates remain reusable", async (t) => {
    geocodeEnvironment(t, { GEOCODE_ENDPOINT: "http://localhost:8088/search", GEOCODE_DATASET: "berlin" })
    const query = { street: "Teststraße 1", postalcode: "10115", city: "Berlin", country: "DE" }
    const hit = { query, lat: "52.5", lon: "13.4" }
    const miss = { query: { ...query, street: "Teststraße 2" }, lat: null, lon: null }
    const fixture = addressFixture("geocache-miss-retry", { old: hit, missing: miss })
    let dataUpdated = "2026-10-02T19:38:48+00:00", found = false, searches = 0
    const fetch = t.mock.method(globalThis, "fetch", async (url) => {
        assert.equal(new URL(url).hostname, "localhost", "a valid empty result must not trigger public fallback")
        if (new URL(url).pathname === "/status") return { ok: true, json: async () => ({ status: 0, data_updated: dataUpdated }) }
        searches++
        assert.equal(new URL(url).searchParams.get("street"), "Teststraße 2", "successful cache hits remain untouched")
        return { ok: true, json: async () => found ? [{ lat: "52.6", lon: "13.5" }] : [] }
    })
    const addresses = postalAddress(1) + postalAddress(2) + postalAddress(3, "Teststraße 2")
    const cachedMiss = () => Object.values(fixture.cache().entries).find((entry) => entry.query.street === "Teststraße 2")
    await fixture.run(addresses)
    assert.equal(searches, 1, "legacy public miss is retried on local provider")
    assert.equal(cachedMiss().dataset, "berlin")
    await fixture.run(addresses)
    assert.equal(searches, 1, "same provider and dataset reuse the miss")
    process.env.GEOCODE_DATASET = "germany"
    await fixture.run(addresses)
    assert.equal(searches, 2, "a different region at the same endpoint retries the miss")
    dataUpdated = "2026-10-03T19:38:48+00:00"
    await fixture.run(addresses)
    assert.equal(searches, 3, "a refreshed OSM snapshot retries the miss")
    assert.equal(cachedMiss().dataUpdated, dataUpdated)
    process.env.GEOCODE_ENDPOINT = "http://localhost:8089/search"
    await fixture.run(addresses)
    assert.equal(searches, 4, "changing the endpoint retries the miss")
    process.env.GEOCODE_RETRY_MISSES = "true"
    found = true
    await fixture.run(addresses)
    assert.equal(searches, 5, "explicit retries still deduplicate addresses")
    assert.equal(geoOf(fixture.root).subjects.length, 3)
    assert.deepEqual(Object.values(fixture.cache().entries).find((entry) => entry.query.street === "Teststraße 1"),
        { ...hit, endpoint: PUBLIC_ENDPOINT })
    const calls = fetch.mock.callCount()
    await fixture.run(addresses)
    assert.equal(fetch.mock.callCount(), calls, "retry-misses does not invalidate successful cached coordinates")
})

test("geocoding checkpoints a long cache fill before its last request completes", async (t) => {
    geocodeEnvironment(t, { GEOCODE_ENDPOINT: "http://localhost:8088/search", GEOCODE_DELAY_MS: "0" })
    const fixture = addressFixture("geocache-checkpoints")
    let requests = 0
    t.mock.method(globalThis, "fetch", async (url) => {
        if (new URL(url).pathname === "/status") return { ok: true, json: async () => ({ status: 0 }) }
        if (++requests === 101)
            assert.equal(Object.keys(fixture.cache().entries).length, 100, "completed batch already on disk")
        return { ok: true, json: async () => [{ lat: "52.5", lon: "13.4" }] }
    })
    await fixture.run(Array.from({ length: 101 }, (_, id) => postalAddress(id)).join("\n"))
    assert.equal(requests, 101)
    assert.equal(Object.keys(fixture.cache().entries).length, 101)
})

test("zero delay cannot remove throttling from the public Nominatim endpoint", async (t) => {
    geocodeEnvironment(t, { GEOCODE_ENDPOINT: "https://NOMINATIM.openstreetmap.org./search", GEOCODE_DELAY_MS: "0" })
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const fixture = addressFixture("geocache-public-delay")
    const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
        assert.equal(options.redirect, "error", "local requests must not follow redirects to a public service")
        assert.ok(options.signal instanceof AbortSignal)
        return { ok: true, json: async () => [{ lat: "52.5", lon: "13.4" }] }
    })
    const pending = fixture.run(postalAddress(1) + postalAddress(2))
    await new Promise(setImmediate)
    assert.equal(fetch.mock.callCount(), 1)
    t.mock.timers.tick(1099)
    await new Promise(setImmediate)
    assert.equal(fetch.mock.callCount(), 1)
    t.mock.timers.tick(1)
    await pending
    assert.equal(fetch.mock.callCount(), 2)
})

test("invalid geocoding settings fail before any lookup or cache write", async (t) => {
    geocodeEnvironment(t, { GEOCODE_ENDPOINT: undefined, GEOCODE_DELAY_MS: undefined, GEOCODE_CACHE_ONLY: undefined })
    const fixture = addressFixture("geocache-invalid-settings")
    const original = fixture.cache()
    t.mock.method(globalThis, "fetch", async () => { throw new Error("invalid config must not fetch") })
    for (const [key, value] of [
        ["GEOCODE_ENDPOINT", "not a URL"], ["GEOCODE_ENDPOINT", "file:///tmp/search"],
        ["GEOCODE_ENDPOINT", "http://user:password@localhost/search"],
        ["GEOCODE_ENDPOINT", "http://localhost/search?country=DE"],
        ["GEOCODE_DELAY_MS", "-1"], ["GEOCODE_DELAY_MS", "NaN"],
        ["GEOCODE_DELAY_MS", "0.5"], ["GEOCODE_DELAY_MS", "2147483648"],
        ["GEOCODE_CACHE_ONLY", "yes"], ["GEOCODE_RETRY_MISSES", "yes"],
    ]) {
        process.env[key] = value
        await assert.rejects(fixture.run(postalAddress(1)))
        assert.deepEqual(fixture.cache(), original)
        delete process.env[key]
    }
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

// Keep real HTTP after timer mocks: undici owns background keep-alive timers.
test("local Nominatim fills the cache, retains partial results on failure, and permits cache-only reruns", async (t) => {
    const requests = []
    let unavailable = true
    const server = createServer((req, res) => {
        const url = new URL(req.url, "http://localhost")
        if (url.pathname === "/status") {
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ status: 0, data_updated: "2026-10-02T19:38:48+00:00" }))
            return
        }
        requests.push(url)
        assert.match(req.headers["user-agent"], /directory-builder/)
        if (unavailable && url.searchParams.get("street") === "Teststraße 2") {
            res.writeHead(503).end("unavailable")
            return
        }
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify([{ lat: "52.5", lon: "13.4" }]))
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())))
    const endpoint = `http://127.0.0.1:${server.address().port}/search`
    geocodeEnvironment(t, { GEOCODE_ENDPOINT: endpoint, GEOCODE_DELAY_MS: "0", GEOCODE_CACHE_ONLY: "false" })
    const realFetch = globalThis.fetch
    let fallbacks = 0
    const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
        if (new URL(url).origin === new URL(endpoint).origin) return realFetch(url, options)
        assert.equal(new URL(url).origin, new URL(PUBLIC_ENDPOINT).origin)
        fallbacks++
        return { ok: false, status: 503 }
    })
    const fixture = addressFixture("geocache-local")
    const addresses = postalAddress(1) + postalAddress(2) + postalAddress(3, "Teststraße 1")
    await assert.rejects(fixture.run(addresses), /Nominatim answered 503/)
    const partial = Object.values(fixture.cache().entries)
    assert.equal(partial.length, 1, "the completed address survives a later failure")
    assert.equal(partial[0].endpoint, endpoint)
    assert.equal(partial[0].dataUpdated, "2026-10-02T19:38:48+00:00")
    assert.equal(fallbacks, 1)
    assert.equal(fs.existsSync(path.join(fixture.root, PATHS.final)), false, "failed enrichment does not publish partial output")

    unavailable = false
    await fixture.run(addresses)
    assert.deepEqual(requests.map((url) => url.searchParams.get("street")), ["Teststraße 1", "Teststraße 2", "Teststraße 2"])
    assert.ok(requests.every((url) => url.pathname === "/search" && url.searchParams.get("format") === "jsonv2"
        && url.searchParams.get("country") === "DE" && url.searchParams.get("limit") === "1"))
    assert.equal(geoOf(fixture.root).subjects.length, 3)

    const cached = fixture.cache()
    process.env.GEOCODE_CACHE_ONLY = "true"
    fetch.mock.mockImplementation(async () => { throw new Error("cache-only mode must not fetch") })
    await fixture.run(addresses)
    assert.deepEqual(fixture.cache(), cached)
    await assert.rejects(fixture.run(addresses + postalAddress(4)), /absent from geocache.*CACHE_ONLY/)
    assert.deepEqual(fixture.cache(), cached, "an uncached address is not recorded as a miss")
    assert.deepEqual(fs.readdirSync(path.join(fixture.root, "registry")), ["geocache.json"], "atomic writes leave no temporary files")
})
