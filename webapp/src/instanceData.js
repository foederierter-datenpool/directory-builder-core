// Small bootstrap shared by every route. Large pipeline artifacts are fetched
// by the route that displays them, after its lazy module is opened.

import { CDP, NAMESPACES, objectsOf, parseTtl, PATHS, prefixes, prefixesOf } from "@directory-builder/core/utils"

const pending = new Map()
export const fetchText = (path) => {
    if (!pending.has(path)) pending.set(path, fetch(`${import.meta.env.BASE_URL}${path}`)
        .then(res => res.ok ? res.text() : "")
        .catch(() => ""))
    return pending.get(path)
}
export const fetchTexts = (paths) => Promise.all(paths.map(fetchText))

export const federationTtl = await fetchText(PATHS.federation)

const fedQuads = parseTtl(federationTtl)
// The instance's repo URL (:federation :repository …) — undefined when not
// declared; pages hide their GitHub links then.
export const repositoryUrl = objectsOf(fedQuads, `${CDP}repository`)[0]
// Display prefixes = the federation's own @prefix declarations; cdp pinned
// first so cdp:… wins over the empty ":" prefix bound to the same namespace.
export const displayPrefixes = { ...prefixes("cdp"), ...prefixesOf(federationTtl) }
// The federation's display name (:federation rdfs:label) — optional; the
// webapp keeps its generic title without one.
export const federationLabel = fedQuads.find((q) =>
    q.subject.value === `${CDP}federation` && q.predicate.value === `${NAMESPACES.rdfs}label`)?.object.value

// Navigation uses small metadata and never opens directory.ttl.
export const catalogTtl = await fetchText(PATHS.catalog)
export const mapAvailable = fedQuads.some(q =>
    q.predicate.value === `${CDP}geocode`
    || (q.predicate.value === `${CDP}targetPredicate` && q.object.value === `${NAMESPACES.schema}latitude`))
