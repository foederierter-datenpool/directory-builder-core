// All config + pipeline data the webapp reads, fetched at runtime relative to
// BASE_URL — in dev the vite middleware serves config/ and data/ from the
// repo root; on gh-pages the deploy publishes them next to the bundle.
// federation.ttl is the only bootstrap: the cleaned-file list derives from
// its :hasSource, everything else from the PATHS conventions. A missing
// artifact resolves to "" (pages render empty). Top-level await — importing
// modules stay synchronous.

import { CDP, objectsOf, parseTtl, PATHS, prefixesOf, sourceName } from "@directory-builder/core/utils"

const fetchText = async (path) => {
    const res = await fetch(`${import.meta.env.BASE_URL}${path}`).catch(() => null)
    return res?.ok ? res.text() : ""
}

export const federationTtl = await fetchText(PATHS.federation)

const fedQuads = parseTtl(federationTtl)
const cleanedPaths = objectsOf(fedQuads, `${CDP}hasSource`).map((iri) => PATHS.cleaned(sourceName(iri)))
// The instance's repo URL (:federation :repository …) — undefined when not
// declared; pages hide their GitHub links then.
export const repositoryUrl = objectsOf(fedQuads, `${CDP}repository`)[0]
// Display prefixes = the federation's own @prefix declarations; cdp pinned
// first so cdp:… wins over the empty ":" prefix bound to the same namespace.
export const displayPrefixes = { cdp: CDP, ...prefixesOf(federationTtl) }
// The federation's display name (:federation rdfs:label) — optional; the
// webapp keeps its generic title without one.
export const federationLabel = fedQuads.find((q) =>
    q.subject.value === `${CDP}federation` && q.predicate.value === "http://www.w3.org/2000/01/rdf-schema#label")?.object.value

const FIXED = [PATHS.matchKnowledge, PATHS.ingestLog, PATHS.federateLog, PATHS.mapped,
               PATHS.matches, PATHS.merged, PATHS.provenance, PATHS.final, PATHS.about, PATHS.query]
const [fixedTexts, cleanedTexts] = await Promise.all([
    Promise.all(FIXED.map(fetchText)),
    Promise.all(cleanedPaths.map(fetchText)),
])

export const [matchKnowledgeTtl, ingestLogTtl, federateLogTtl, mappedTtl, matchesTtl, mergedTtl, provenanceTtl, finalTtl, aboutMd, querySparql] = fixedTexts
export const cleanedByPath = Object.fromEntries(cleanedPaths.map((p, i) => [p, cleanedTexts[i]]))
