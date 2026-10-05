import { sparqlSelect } from "@foerderfunke/sem-ops-utils"
import { CDP, groupBySubject, NAMESPACES, parseTtl, prefixes, prefixesOf } from "../../utils.js"
import { writeTurtleFile } from "../write-turtle.js"
import { DataFactory } from "n3"
import { createHash } from "node:crypto"
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
// a committed cache keyed by address query (registry/geocache.json) — a warm
// cache hit needs no network, even when entity IRIs change. Misses can be
// retried when the provider or dataset changes. Results are ODbL:
// "© OpenStreetMap contributors".
//
// A street that misses is retried once with any sub-address tail ("Haus H",
// "4.OG") stripped — from the query only, never from the data. Coordinates
// land as schema:latitude/longitude directly on the entity. When only the
// stripped street hit, the cache entry records it as `adjusted` and the full
// query string sent is annotated in provenance.ttl (cdp:geocodedAs on the
// entity) — an unadjusted lookup needs neither, it's reconstructible from
// the entity itself.

const NOMINATIM = "https://nominatim.openstreetmap.org/search"
const LOCAL_NOMINATIM = "http://127.0.0.1:8088/search"
// Nominatim usage policy: identify the app, at most one request per second.
const USER_AGENT = "directory-builder (https://github.com/foederierter-datenpool/directory-builder-core)"
const THROTTLE_MS = 1100
const CHECKPOINT_EVERY = 100

// Deployment settings belong to the runner, not the instance's RDF model.
// The preferred endpoint implements Nominatim's /status and /search APIs.
const isPublicNominatim = (endpoint) => new URL(endpoint).hostname.replace(/\.$/, "") === "nominatim.openstreetmap.org"
const booleanSetting = (name) => {
    const value = process.env[name] ?? "false"
    if (!["true", "false"].includes(value)) throw new Error(`${name} must be true or false`)
    return value === "true"
}
const geocodingOptions = () => {
    const endpoint = new URL(process.env.GEOCODE_ENDPOINT || LOCAL_NOMINATIM)
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password
        || endpoint.search || endpoint.hash)
        throw new Error("GEOCODE_ENDPOINT must be an HTTP(S) search URL without credentials, query or fragment")
    const delay = Number(process.env.GEOCODE_DELAY_MS ?? 0)
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 2147483647)
        throw new Error("GEOCODE_DELAY_MS must be a non-negative integer below 2147483648")
    return {
        endpoint: endpoint.href, delay,
        dataset: process.env.GEOCODE_DATASET?.trim() || undefined,
        cacheOnly: booleanSetting("GEOCODE_CACHE_ONLY"),
        retryMisses: booleanSetting("GEOCODE_RETRY_MISSES"),
    }
}

// Resolve lazily: a run containing only cached coordinates needs no service.
// Availability and dataset metadata are checked once per run, not per address.
const selectGeocoder = async ({ endpoint, dataset }) => {
    if (isPublicNominatim(endpoint)) return { endpoint }
    try {
        const statusUrl = new URL("status?format=json", endpoint)
        const response = await fetch(statusUrl, {
            headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(3000), redirect: "error",
        })
        if (!response.ok) throw new Error(`status HTTP ${response.status}`)
        const status = await response.json()
        if (status.status !== 0) throw new Error("status is not ready")
        const dataUpdated = typeof status.data_updated === "string" ? status.data_updated : undefined
        console.log(`enrich: using ${endpoint}${dataset ? ` (${dataset})` : ""}`)
        return { endpoint, ...(dataset && { dataset }), ...(dataUpdated && { dataUpdated }) }
    } catch (error) {
        console.warn(`enrich: ${endpoint} unavailable (${error.message}); using public Nominatim with throttling`)
        return { endpoint: NOMINATIM }
    }
}

const sameGeocoder = (entry, provider) =>
    entry.endpoint === provider.endpoint
    && entry.dataset === provider.dataset && entry.dataUpdated === provider.dataUpdated

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

// Keep address components separate, including an absent country. Only case,
// Unicode composition and whitespace are normalised; house numbers and accents
// remain significant. The original query stays in the cache for inspection.
const addressKey = (query) => createHash("sha256").update(JSON.stringify(
    Object.keys(QUERY_FIELDS).map((field) => (query[field] ?? "")
        .normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase()),
)).digest("hex")

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

const lookup = async (query, endpoint) => {
    const url = new URL(endpoint)
    url.searchParams.set("format", "jsonv2")
    url.searchParams.set("limit", "1")
    for (const [slot, value] of Object.entries(query)) url.searchParams.set(slot, value)
    const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60_000), redirect: "error",
    })
    if (!res.ok) throw new Error(`Nominatim answered ${res.status} for ${url}`)
    const results = await res.json()
    if (!Array.isArray(results)) throw new Error(`Invalid Nominatim response from ${endpoint}`)
    const [best] = results
    if (!best) return { lat: null, lon: null }
    if (best.lat == null || best.lon == null || !Number.isFinite(Number(best.lat)) || !Number.isFinite(Number(best.lon)))
        throw new Error(`Invalid Nominatim coordinates from ${endpoint}`)
    return { lat: String(best.lat), lon: String(best.lon) }
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
    const options = geocodingOptions()

    const cache = fs.existsSync(abs(cachePath))
        ? JSON.parse(fs.readFileSync(abs(cachePath), "utf8"))
        : { license: "Data © OpenStreetMap contributors, ODbL 1.0 — https://osm.org/copyright", entries: {} }

    // Read both entity-keyed and address-keyed caches through their saved query.
    // Conflicting results for one address need a fresh lookup, not an arbitrary
    // choice based on which entity happened to be listed first.
    const entries = {}
    const conflicts = new Set()
    for (const cached of Object.values(cache.entries)) {
        // Older caches recorded one origin for every entry. Move that origin
        // onto each entry so the cache has a single, unambiguous format.
        const entry = { ...cached, endpoint: cached.endpoint ?? cache.endpoint ?? NOMINATIM }
        const key = addressKey(entry.query)
        const previous = entries[key]
        if (previous && (previous.lat !== entry.lat || previous.lon !== entry.lon
            || previous.adjusted !== entry.adjusted)) {
            conflicts.add(key)
            delete entries[key]
        }
        if (!conflicts.has(key)) entries[key] = entry
    }
    if (conflicts.size) console.warn(`enrich: ${conflicts.size} address(es) have conflicting cached results; fresh lookups required when used`)

    const saveCache = () => {
        fs.mkdirSync(path.dirname(abs(cachePath)), { recursive: true })
        const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)))
        const value = { license: cache.license, entries: sorted }
        const temporary = `${abs(cachePath)}.${process.pid}.tmp`
        try {
            fs.writeFileSync(temporary, JSON.stringify(value, null, 4) + "\n")
            fs.renameSync(temporary, abs(cachePath))
        } finally {
            fs.rmSync(temporary, { force: true })
        }
    }

    const wanted = new Set(targetClasses)
    const entities = [...groupBySubject(quads)]
        .filter(([, row]) => row.get(RDF_TYPE)?.some((t) => wanted.has(t)))

    let lookups = 0, skipped = 0, completed = 0
    const keys = new Map()
    const processed = new Set()
    const requestedEndpoints = new Set()
    let provider
    const throttled = async (query, { endpoint }) => {
        // Apply the public floor even after switching away from a fast local service.
        const delay = isPublicNominatim(endpoint) ? Math.max(THROTTLE_MS, options.delay) : options.delay
        if (requestedEndpoints.has(endpoint) && delay) await sleep(delay)
        requestedEndpoints.add(endpoint)
        lookups++
        return lookup(query, endpoint)
    }
    const lookupAddress = async (query, selected) => {
        let { lat, lon } = await throttled(query, selected)
        const stripped = query.street.replace(SUB_ADDRESS, "")
        if (lat == null && stripped !== query.street) {
            ({ lat, lon } = await throttled({ ...query, street: stripped }, selected))
            if (lat != null) return { lat, lon, adjusted: stripped }
        }
        return { lat, lon }
    }
    try {
        for (const [iri, row] of entities) {
            const query = {}
            for (const [slot, pred] of Object.entries(QUERY_FIELDS)) {
                const value = row.get(pred)?.[0]
                if (value) query[slot] = value
            }
            // Too little to pin a location — counted, not fatal (the summary line shows it).
            if (!query.street || !(query.postalcode || query.city)) { skipped++; continue }
            const key = addressKey(query)
            keys.set(iri, key)
            if (processed.has(key)) continue
            processed.add(key)
            const entry = entries[key]
            if (entry && (options.cacheOnly || (entry.lat != null && entry.lon != null))) continue
            if (options.cacheOnly)
                throw new Error(`enrich: address absent from geocache in GEOCODE_CACHE_ONLY mode: ${queryString(query)}`)
            provider ??= await selectGeocoder(options)
            if (entry && !options.retryMisses && sameGeocoder(entry, provider)) continue
            let result
            try {
                result = await lookupAddress(query, provider)
            } catch (error) {
                if (isPublicNominatim(provider.endpoint)) throw error
                console.warn(`enrich: ${provider.endpoint} lookup failed (${error.message}); using public Nominatim with throttling`)
                provider = { endpoint: NOMINATIM }
                if (entry && !options.retryMisses && sameGeocoder(entry, provider)) continue
                result = await lookupAddress(query, provider)
            }
            if (result.lat == null) console.warn(`enrich: no Nominatim result for <${iri}> (${Object.values(query).join(", ")})`)
            entries[key] = { query, ...result, ...provider }
            if (++completed % CHECKPOINT_EVERY === 0) {
                saveCache()
                console.log(`enrich: cached ${completed} new address(es) (${lookups} lookup(s))`)
            }
        }
    } finally {
        // Preserve completed results even if a later request fails. Periodic
        // checkpoints also bound lost work on a forced process interruption.
        saveCache()
    }

    const provenance = []
    const coordinates = entities.flatMap(([iri]) => {
        const { query, adjusted, lat, lon } = entries[keys.get(iri)] ?? {}
        if (lat == null || lon == null) return []
        if (adjusted)
            provenance.push(df.quad(df.namedNode(iri), df.namedNode(`${CDP}geocodedAs`),
                df.literal(queryString({ ...query, street: adjusted }))))
        return [
            df.quad(df.namedNode(iri), df.namedNode(`${SCHEMA}latitude`), df.literal(lat)),
            df.quad(df.namedNode(iri), df.namedNode(`${SCHEMA}longitude`), df.literal(lon)),
        ]
    })

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
