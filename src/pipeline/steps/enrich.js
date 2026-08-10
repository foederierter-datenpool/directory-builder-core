import { sparqlSelect } from "@foerderfunke/sem-ops-utils"
import { CDP, groupBySubject, NAMESPACES, parseTtl, prefixesOf } from "../../utils.js"
import { writeTurtleFile } from "../write-turtle.js"
import { DataFactory } from "n3"
import path from "path"
import fs from "fs"

const df = DataFactory
const SCHEMA = NAMESPACES.schema
const RDF_TYPE = `${NAMESPACES.rdf}type`

// ---- Enrich step -----------------------------------------------------------
// The one step past resolve that adds data no source carries: geocoding the
// entities of each :geocode'd target schema via Nominatim (OSM). Opt-in
// through config:
//
//   :enrich a :EnrichRule ; :geocode :adresseSchema .
//
// It runs after resolve on purpose: merge has collapsed duplicates and
// :ValueCorrection has rewritten known-wrong literals, so each canonical
// address is looked up exactly once, with corrected values. Lookups go through
// a committed cache keyed by entity IRI (registry/geocache.json) — a warm
// cache needs no network, and a cached miss is retried only when the address
// changes. Results are ODbL: "© OpenStreetMap contributors".
//
// A street that misses is retried once with any sub-address tail ("Haus H",
// "4.OG") stripped — from the query only, never from the data. Coordinates
// land as schema:latitude/longitude directly on the entity. When only the
// stripped street hit, the cache entry records it as `adjusted` and the full
// query string sent is annotated in provenance.ttl (cdp:geocodedAs on the
// entity) — an unadjusted lookup needs neither, it's reconstructible from
// the entity itself.

const NOMINATIM = "https://nominatim.openstreetmap.org/search"
// Nominatim usage policy: identify the app, at most one request per second.
const USER_AGENT = "directory-builder (https://github.com/foederierter-datenpool/directory-builder-core)"
const THROTTLE_MS = 1100

// Sub-address tails Nominatim can't place, stripped for the retry: a marker
// word (optionally "4."-prefixed for floors), anything after it included.
const SUB_ADDRESS = /\s*,?\s*(?:(?:\d+\s*\.\s*)?(?:og|eg|etage|stock(?:werk)?)|haus|geb(?:äude)?|aufgang|eingang|raum|zimmer|hinterhaus|vorderhaus|seitenflügel)\b.*$/i

// One human-readable line for what a query sent: "Genter Straße 63, 13353 Berlin, DE".
const queryString = (q) => [q.street, [q.postalcode, q.city].filter(Boolean).join(" "), q.country]
    .filter(Boolean).join(", ")

// Structured-query slots, filled from the entity's schema.org address fields.
// Geocoding is defined over postal addresses, whose vocabulary schema.org
// fixes — so unlike mappings, these predicates aren't config.
const QUERY_FIELDS = {
    street:     `${SCHEMA}streetAddress`,
    postalcode: `${SCHEMA}postalCode`,
    city:       `${SCHEMA}addressLocality`,
    country:    `${SCHEMA}addressCountry`,
}

// The target classes to geocode; empty (no :EnrichRule) → federate skips the step.
export const geocodeTargets = async (defStore) =>
    (await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?class WHERE { ?rule a :EnrichRule ; :geocode [ :targetClass ?class ] }`, [defStore]))
        .map((row) => row.class)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const lookup = async (query) => {
    const url = new URL(NOMINATIM)
    url.searchParams.set("format", "jsonv2")
    url.searchParams.set("limit", "1")
    for (const [slot, value] of Object.entries(query)) url.searchParams.set(slot, value)
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } })
    if (!res.ok) throw new Error(`Nominatim answered ${res.status} for ${url}`)
    const [best] = await res.json()
    return { lat: best?.lat ?? null, lon: best?.lon ?? null }
}

export const runEnrich = async ({ abs }, targetClasses, inPath, outPath, provPath, cachePath) => {
    const resolvedTtl = fs.readFileSync(abs(inPath), "utf8")
    const quads = parseTtl(resolvedTtl)
    const cache = fs.existsSync(abs(cachePath))
        ? JSON.parse(fs.readFileSync(abs(cachePath), "utf8"))
        : { license: "Data © OpenStreetMap contributors, ODbL 1.0 — https://osm.org/copyright", entries: {} }

    const wanted = new Set(targetClasses)
    const entities = [...groupBySubject(quads)]
        .filter(([, row]) => row.get(RDF_TYPE)?.some((t) => wanted.has(t)))

    let lookups = 0, skipped = 0
    const throttled = async (query) => { if (lookups++) await sleep(THROTTLE_MS); return lookup(query) }
    for (const [iri, row] of entities) {
        const query = {}
        for (const [slot, pred] of Object.entries(QUERY_FIELDS)) {
            const value = row.get(pred)?.[0]
            if (value) query[slot] = value
        }
        // Too little to pin a location — counted, not fatal (the summary line shows it).
        if (!query.street || !(query.postalcode || query.city)) { skipped++; continue }
        const hit = cache.entries[iri]
        if (hit && JSON.stringify(hit.query) === JSON.stringify(query)) continue
        let adjusted
        let { lat, lon } = await throttled(query)
        const stripped = query.street.replace(SUB_ADDRESS, "")
        if (lat == null && stripped !== query.street) {
            ({ lat, lon } = await throttled({ ...query, street: stripped }))
            if (lat != null) adjusted = stripped
        }
        if (lat == null) console.warn(`enrich: no Nominatim result for <${iri}> (${Object.values(query).join(", ")})`)
        cache.entries[iri] = { query, ...(adjusted && { adjusted }), lat, lon }
    }

    const provQuads = []
    const geoQuads = entities.flatMap(([iri]) => {
        const { query, adjusted, lat, lon } = cache.entries[iri] ?? {}
        if (lat == null) return []
        if (adjusted)
            provQuads.push(df.quad(df.namedNode(iri), df.namedNode(`${CDP}geocodedAs`),
                df.literal(queryString({ ...query, street: adjusted }))))
        return [
            df.quad(df.namedNode(iri), df.namedNode(`${SCHEMA}latitude`), df.literal(lat)),
            df.quad(df.namedNode(iri), df.namedNode(`${SCHEMA}longitude`), df.literal(lon)),
        ]
    })

    fs.mkdirSync(path.dirname(abs(cachePath)), { recursive: true })
    const entries = Object.fromEntries(Object.entries(cache.entries).sort(([a], [b]) => a.localeCompare(b)))
    fs.writeFileSync(abs(cachePath), JSON.stringify({ license: cache.license, endpoint: NOMINATIM, entries }, null, 4) + "\n")
    await writeTurtleFile(abs(outPath), [...quads, ...geoQuads], prefixesOf(resolvedTtl))
    console.log(`enrich: geocoded ${geoQuads.length / 2}/${entities.length} entities`
        + ` (${lookups} lookup(s), ${skipped} lacking address fields) → ${outPath}`)

    if (provQuads.length) {
        const provTtl = fs.readFileSync(abs(provPath), "utf8")
        await writeTurtleFile(abs(provPath), [...parseTtl(provTtl), ...provQuads], prefixesOf(provTtl))
        console.log(`enrich: annotated ${provQuads.length} tail-stripped lookup(s) → ${provPath}`)
    }
}
