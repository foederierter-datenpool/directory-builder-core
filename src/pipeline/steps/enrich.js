import { sparqlSelect } from "@foerderfunke/sem-ops-utils"
import { CDP, groupBySubject, NAMESPACES, parseTtl, prefixes, prefixesOf } from "../../utils.js"
import { writeTurtleFile } from "../write-turtle.js"
import { DataFactory } from "n3"
import path from "path"
import fs from "fs"

const df = DataFactory
const SCHEMA = NAMESPACES.schema
const RDF_TYPE = `${NAMESPACES.rdf}type`
const RDF_REIFIES = df.namedNode(`${NAMESPACES.rdf}reifies`)
const PROV_DERIVED_FROM = df.namedNode(`${NAMESPACES.prov}wasDerivedFrom`)
const PROV_GENERATED_BY = df.namedNode(`${NAMESPACES.prov}wasGeneratedBy`)
const APPLIED_RULE = df.namedNode(`${CDP}appliedRule`)
const ENRICH_STEP = df.namedNode(`${CDP}enrichStep`)

// ---- Enrich step -----------------------------------------------------------
// The one step past resolve that derives values after sources have been merged
// and conflicts resolved. It supports geocoding and inheritance over a linked
// entity. Both capabilities are opt-in through config:
//
//   :enrich a :EnrichRule ;
//       :geocode :adresseSchema ;
//       :inherit :inheritEinrichtungToAngebot .
//   :inheritEinrichtungToAngebot a :InheritanceRule ;
//       :from :einrichtungSchema ; :to :angebotSchema ;
//       :through schema:provider ; :on schema:openingHours .
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

// Resolve schema references in the rule to their classes once. The inheritance
// direction is destination --:through--> source: an Angebot points to the
// Einrichtung whose values it receives.
export const loadEnrichConfig = async (defStore) => {
    const geocodeClasses = (await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?class WHERE { ?rule a :EnrichRule ; :geocode [ :targetClass ?class ] }`, [defStore]))
        .map((row) => row.class)

    const inheritance = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?inheritance ?sourceClass ?destinationClass ?through ?on WHERE {
            ?enrich a :EnrichRule ; :inherit ?inheritance .
            ?inheritance :from/:targetClass ?sourceClass ;
                         :to/:targetClass ?destinationClass ;
                         :through ?through ;
                         :on ?on .
        }`, [defStore])

    return { geocodeClasses: [...new Set(geocodeClasses)], inheritance }
}

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

const termKey = (term) => [
    term.termType,
    term.value,
    term.language,
    term.datatype?.value,
].join("|")

const valuesIndex = (quads) => {
    const values = new Map()
    for (const quad of quads) {
        const key = `${quad.subject.value}\t${quad.predicate.value}`
        if (!values.has(key)) values.set(key, [])
        values.get(key).push(quad.object)
    }
    return (subject, predicate) => values.get(`${subject}\t${predicate}`) ?? []
}

// Copy only when the destination has no value of its own. One provenance
// reifier per copy records the linked source entity, the executed enrich step,
// and the exact configured inheritance rule. The source entity's own value
// remains traceable to its source record through merge provenance.
const inheritValues = (quads, rules) => {
    const valuesOf = valuesIndex(quads)
    const inherited = []
    const provenance = []
    const seen = new Set()

    for (const rule of rules) {
        const links = quads.filter((quad) => quad.predicate.value === rule.through)
        for (const link of links) {
            const destination = link.subject.value
            const source = link.object.value
            const destinationTypes = valuesOf(destination, RDF_TYPE).map((term) => term.value)
            const sourceTypes = valuesOf(source, RDF_TYPE).map((term) => term.value)

            const correctDestination = destinationTypes.includes(rule.destinationClass)
            const correctSource = sourceTypes.includes(rule.sourceClass)
            if (!correctDestination || !correctSource) continue
            if (valuesOf(destination, rule.on).length) continue

            for (const value of valuesOf(source, rule.on)) {
                const key = `${destination}\t${rule.on}\t${termKey(value)}\t${source}`
                if (seen.has(key)) continue
                seen.add(key)

                const copied = df.quad(link.subject, df.namedNode(rule.on), value)
                const reifier = df.blankNode()
                inherited.push(copied)
                provenance.push(
                    df.quad(reifier, RDF_REIFIES, copied),
                    df.quad(reifier, PROV_DERIVED_FROM, link.object),
                    df.quad(reifier, PROV_GENERATED_BY, ENRICH_STEP),
                    df.quad(reifier, APPLIED_RULE, df.namedNode(rule.inheritance)),
                )
            }
        }
    }
    return { inherited, provenance }
}

const geocode = async ({ abs }, quads, targetClasses, cachePath) => {
    if (!targetClasses.length) return { coordinates: [], provenance: [] }

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

    const provenance = []
    const coordinates = entities.flatMap(([iri]) => {
        const { query, adjusted, lat, lon } = cache.entries[iri] ?? {}
        if (lat == null) return []
        if (adjusted)
            provenance.push(df.quad(df.namedNode(iri), df.namedNode(`${CDP}geocodedAs`),
                df.literal(queryString({ ...query, street: adjusted }))))
        return [
            df.quad(df.namedNode(iri), df.namedNode(`${SCHEMA}latitude`), df.literal(lat)),
            df.quad(df.namedNode(iri), df.namedNode(`${SCHEMA}longitude`), df.literal(lon)),
        ]
    })

    fs.mkdirSync(path.dirname(abs(cachePath)), { recursive: true })
    const entries = Object.fromEntries(Object.entries(cache.entries).sort(([a], [b]) => a.localeCompare(b)))
    fs.writeFileSync(abs(cachePath), JSON.stringify({ license: cache.license, endpoint: NOMINATIM, entries }, null, 4) + "\n")
    console.log(`enrich: geocoded ${coordinates.length / 2}/${entities.length} entities`
        + ` (${lookups} lookup(s), ${skipped} lacking address fields)`)
    return { coordinates, provenance }
}

export const runEnrich = async ({ abs }, config, inPath, outPath, provPath, cachePath) => {
    const resolvedTtl = fs.readFileSync(abs(inPath), "utf8")
    const resolved = parseTtl(resolvedTtl)
    const inherited = inheritValues(resolved, config.inheritance)
    const geocoded = await geocode({ abs }, resolved, config.geocodeClasses, cachePath)

    await writeTurtleFile(abs(outPath), [...resolved, ...inherited.inherited, ...geocoded.coordinates], prefixesOf(resolvedTtl))
    console.log(`enrich: inherited ${inherited.inherited.length} value(s); wrote final data → ${outPath}`)

    const additions = [...inherited.provenance, ...geocoded.provenance]
    if (!additions.length) return

    const provTtl = fs.readFileSync(abs(provPath), "utf8")
    const provPrefixes = { ...prefixesOf(provTtl), ...prefixes("cdp", "prov", "rdf") }
    await writeTurtleFile(abs(provPath), [...parseTtl(provTtl), ...additions], provPrefixes)
    console.log(`enrich: wrote ${additions.length} provenance triple(s) → ${provPath}`)
}
