// How resolve settles each Merge conflict: the strategy federation.ttl assigns
// to the predicate, the value(s) that survived into final.ttl, and any curated
// :ValueCorrection (match-knowledge.ttl) touching the field — a correction's
// :entity is translated member → cluster via matches.ttl, mirroring the engine.
// Reads:  config/{federation,match-knowledge}.ttl, data/pipeline/{matches,final}.ttl
// Does:   exports resolutionOf(entityIri, field) → { strategy, finals, corrections }

import { CDP, parseTtl, shrink } from "@directory-builder/core/utils"
import { federationTtl, matchKnowledgeTtl, matchesTtl, finalTtl, displayPrefixes } from "./instanceData.js"

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
const local = (iri) => iri.split("#").pop()
const objOf = (quads, subj, pred) => quads.find((q) => q.subject.value === subj && q.predicate.value === `${CDP}${pred}`)?.object.value

// :ResolveRule strategy per predicate: :hasOverride [ :on ; :strategy ],
// else :defaultStrategy, else the engine's longestValue fallback.
const fedQuads = parseTtl(federationTtl)
const defaultStrategy = fedQuads.find((q) => q.predicate.value === `${CDP}defaultStrategy`)?.object.value ?? `${CDP}longestValue`
const overrides = new Map(fedQuads.filter((q) => q.predicate.value === `${CDP}hasOverride`)
    .map((q) => [objOf(fedQuads, q.object.value, "on"), objOf(fedQuads, q.object.value, "strategy")]))

const mintedOf = new Map(parseTtl(matchesTtl).filter((q) => q.predicate.value === `${CDP}hasMember`)
    .map((q) => [q.object.value, q.subject.value]))

const mkQuads = parseTtl(matchKnowledgeTtl)
const CORRECTIONS = mkQuads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === `${CDP}ValueCorrection`)
    .map((q) => {
        const entity = objOf(mkQuads, q.subject.value, "entity")
        return {
            entity: entity && (mintedOf.get(entity) ?? entity),
            on: objOf(mkQuads, q.subject.value, "on"),
            wrong: objOf(mkQuads, q.subject.value, "wrong"),
            right: objOf(mkQuads, q.subject.value, "right"),
        }
    })

const finalIndex = new Map()
for (const q of parseTtl(finalTtl)) {
    if (q.predicate.value === RDF_TYPE) continue
    const k = `${q.subject.value}\t${q.predicate.value}`
    if (!finalIndex.has(k)) finalIndex.set(k, [])
    finalIndex.get(k).push(q.object.termType === "NamedNode" ? shrink(q.object.value, displayPrefixes) : q.object.value)
}

export const resolutionOf = (entityIri, field) => {
    const corrections = CORRECTIONS.filter((c) => c.on === field.predicate
        && (!c.entity || c.entity === entityIri)
        && field.values.some((v) => v.raw === c.wrong))
    // Corrections run before the strategy (mirroring the engine): they rewrite
    // the candidate values, and the strategy only decides when disagreement
    // remains afterwards — strategyDecides tells the tooltip whom to credit.
    const afterCuration = new Set(field.values.map((v) => corrections.find((c) => c.wrong === v.raw)?.right ?? v.raw))
    return {
        strategy: local(overrides.get(field.predicate) ?? defaultStrategy),
        finals: finalIndex.get(`${entityIri}\t${field.predicate}`) ?? [],
        corrections,
        strategyDecides: afterCuration.size > 1,
    }
}
