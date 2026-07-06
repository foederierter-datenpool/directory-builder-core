// Loader for the Entities view's Prepare mode. Reads the pipeline's per-source
// preparation artifacts (data/pipeline/preparation/<source>.ttl) and shapes them
// into per-source, per-entity before→after rows + the match key. Pure (ttl +
// bundled artifacts in → view data out).
// Reads:  config/federation.ttl (field labels, source list) + preparation/*.ttl

import { CDP, localName, parseTtl, PATHS, sourceName } from "@directory-builder/core/utils"
import { preparationByPath, repositoryUrl } from "./instanceData.js"
import { loadSources } from "./loadMap.js"

export function loadPreparation(ttl, { hiddenSources } = {}) {
    const fed = parseTtl(ttl)
    // A parsed field references its :SourceField IRI; show its :fieldPath. An
    // in-place field is already a fieldPath literal, shown as-is.
    const fieldPathOf = new Map(fed.filter((q) => q.predicate.value === `${CDP}fieldPath`).map((q) => [q.subject.value, q.object.value]))
    const sources = loadSources(ttl).filter((s) => !hiddenSources?.has(s.iri))

    return sources.map((s) => {
        const quads = parseTtl(preparationByPath[PATHS.preparation(sourceName(s.iri))] ?? "")
        const entities = new Map()   // entity IRI → { matchString, diffs: [] }
        const bucket = (e) => entities.get(e) ?? entities.set(e, { diffs: [] }).get(e)
        // Prepared diffs hang off blank nodes; collect their parts, then join.
        // parsed = the field was a :SourceField IRI (a declared derivation, one
        // raw field split into targets); otherwise an in-place normalisation.
        const body = new Map()       // bnode → { field, before, after, parsed }
        const part = (b) => body.get(b) ?? body.set(b, {}).get(b)
        const prepared = []          // [entity, bnode]
        for (const q of quads) {
            const p = q.predicate.value, o = q.object.value
            if      (p === `${CDP}matchString`) bucket(q.subject.value).matchString = o
            else if (p === `${CDP}prepared`)    prepared.push([q.subject.value, o])
            else if (p === `${CDP}field`)       Object.assign(part(q.subject.value), q.object.termType === "NamedNode" ? { field: fieldPathOf.get(o) ?? localName(o), parsed: true } : { field: o, parsed: false })
            else if (p === `${CDP}rawValue`)    part(q.subject.value).before = o
            else if (p === `${CDP}cleanValue`)  part(q.subject.value).after = o
        }
        for (const [entity, b] of prepared) bucket(entity).diffs.push(body.get(b))
        return {
            iri: s.iri,
            label: s.label,
            // The extract.sparql that produced these splits/normalisations, on the
            // repo's default branch (/blob/HEAD/); null when no repo is declared.
            queryHref: repositoryUrl ? `${repositoryUrl}/blob/HEAD/${PATHS.extractQuery(sourceName(s.iri))}` : null,
            entities: [...entities].map(([iri, v]) => ({ iri, label: localName(iri), matchString: v.matchString, diffs: v.diffs })),
        }
    }).filter((s) => s.entities.length)
}
