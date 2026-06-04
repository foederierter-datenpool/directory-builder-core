// Helpers for the Map view: build the schema-mapping graph and resolve per-org
// source/target field values. Pure (ttl in → data out).
// Reads:  TTL strings passed by MapGraph.jsx (federation, mapped, cleaned source TTL)
// Does:   returns { nodes, edges } plus per-source / per-org value maps

import { CDP as NS, localName, parseTtl, prefixesOf, shrink, sourceName, subjectsOfType, typesOf } from "@directory-builder/core/utils"

const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
const NODE_TYPES = [`${NS}Source`, `${NS}SourceField`, `${NS}TargetField`, `${NS}TargetSchema`]
const SUB_FIELD = `${NS}SubField`

// Group orgs by source. Each org carries a cdp:fromSource triple in mapped.ttl
// pointing at its Source IRI, so this is a single-pass scan with no prefix
// matching.
export function loadOrgsBySource(_federationTtl, mappedTtl) {
    const SCHEMA_NAME       = "http://schema.org/name"
    const SCHEMA_IDENTIFIER = "http://schema.org/identifier"
    const FROM_SOURCE       = `${NS}fromSource`

    const orgSource = new Map()  // orgIri -> sourceIri
    const ids       = new Map()
    const names     = new Map()
    for (const q of parseTtl(mappedTtl)) {
        const p = q.predicate.value
        if      (p === FROM_SOURCE)       orgSource.set(q.subject.value, q.object.value)
        else if (p === SCHEMA_IDENTIFIER) ids.set(q.subject.value, q.object.value)
        else if (p === SCHEMA_NAME)       names.set(q.subject.value, q.object.value)
    }

    const result = new Map()
    for (const [iri, src] of orgSource) {
        if (!result.has(src)) result.set(src, [])
        result.get(src).push({
            iri,
            id:   ids.get(iri) ?? localName(iri),
            name: names.get(iri) ?? "",
        })
    }
    for (const list of result.values()) list.sort((a, b) => a.id.localeCompare(b.id))
    return result
}

// For each org in mapped.ttl, resolve the literal value of each of its
// source fields/sub-fields (from the source's lifted/cleaned TTL) AND each
// target field (from mapped.ttl, indirected via the field's :targetPredicate).
// Returns Map<orgIri, Map<fieldIri, string>>.
export function loadFieldValuesByOrg(federationTtl, mappedTtl, liftedBySource) {
    const fedQuads = parseTtl(federationTtl)
    const fieldPathOf       = new Map()
    const fieldsBySource    = new Map()
    const subFieldsOf       = new Map()
    const targetPredicateOf = new Map()
    for (const q of fedQuads) {
        const p = q.predicate.value
        if      (p === `${NS}fieldPath`)        fieldPathOf.set(q.subject.value, q.object.value)
        else if (p === `${NS}targetPredicate`)  targetPredicateOf.set(q.subject.value, q.object.value)
        else if (p === `${NS}hasField`) {
            if (!fieldsBySource.has(q.subject.value)) fieldsBySource.set(q.subject.value, [])
            fieldsBySource.get(q.subject.value).push(q.object.value)
        } else if (p === `${NS}hasSubField`) {
            if (!subFieldsOf.has(q.subject.value)) subFieldsOf.set(q.subject.value, [])
            subFieldsOf.get(q.subject.value).push(q.object.value)
        }
    }

    const FROM_SOURCE = `${NS}fromSource`
    const orgSource     = new Map() // orgIri -> sourceIri
    const literalsByOrg = new Map() // orgIri -> Map<predicateIri, string>
    for (const q of parseTtl(mappedTtl)) {
        if (q.predicate.value === FROM_SOURCE) orgSource.set(q.subject.value, q.object.value)
        if (q.object.termType === "Literal") {
            if (!literalsByOrg.has(q.subject.value)) literalsByOrg.set(q.subject.value, new Map())
            literalsByOrg.get(q.subject.value).set(q.predicate.value, q.object.value)
        }
    }

    const result = new Map()
    for (const [sourceIri, liftedTtl] of liftedBySource) {
        // subject -> Map<predicate-localname, [{value, isLiteral}]>
        const graph = new Map()
        for (const q of parseTtl(liftedTtl)) {
            const sub = q.subject.value
            const predLocal = localName(q.predicate.value)
            if (!graph.has(sub)) graph.set(sub, new Map())
            const preds = graph.get(sub)
            if (!preds.has(predLocal)) preds.set(predLocal, [])
            preds.get(predLocal).push({ value: q.object.value, isLiteral: q.object.termType === "Literal" })
        }

        const fields = fieldsBySource.get(sourceIri) ?? []
        for (const [orgIri, src] of orgSource) {
            if (src !== sourceIri) continue
            // Source subject IS the federation IRI post-clean — no lookup needed.
            const subjectPreds = graph.get(orgIri)
            if (!subjectPreds) continue

            const valueMap = new Map()
            for (const fieldIri of fields) {
                const fp = fieldPathOf.get(fieldIri)
                if (!fp) continue
                const vs = subjectPreds.get(fp)
                if (!vs?.length) continue
                const v = vs[0]
                if (v.isLiteral && v.value) valueMap.set(fieldIri, v.value)
                // Sub-fields hang off the parent field's blank-node value.
                if (subFieldsOf.has(fieldIri) && !v.isLiteral) {
                    const childPreds = graph.get(v.value)
                    if (childPreds) {
                        for (const subIri of subFieldsOf.get(fieldIri)) {
                            const subFp = fieldPathOf.get(subIri)
                            if (!subFp) continue
                            const subVs = childPreds.get(subFp)
                            if (subVs?.length && subVs[0].isLiteral && subVs[0].value) valueMap.set(subIri, subVs[0].value)
                        }
                    }
                }
            }
            result.set(orgIri, valueMap)
        }
    }

    // Layer in target-field values: indirect each :targetPredicate through the
    // org's literal predicate->value map from mapped.ttl. These are the values
    // that flow OUT of transform nodes (and equal the source value for direct
    // 1:1 mappings).
    for (const [orgIri, preds] of literalsByOrg) {
        if (!result.has(orgIri)) result.set(orgIri, new Map())
        const valueMap = result.get(orgIri)
        for (const [tfIri, predIri] of targetPredicateOf) {
            const v = preds.get(predIri)
            if (v) valueMap.set(tfIri, v)
        }
    }
    return result
}

export function loadSources(ttl) {
    const quads = parseTtl(ttl)
    const sourceIris = subjectsOfType(quads, `${NS}Source`)
    const labelOf = new Map()
    for (const q of quads) if (q.predicate.value === RDFS_LABEL) labelOf.set(q.subject.value, q.object.value)
    return [...sourceIris].map((iri) => ({ iri, label: labelOf.get(iri) ?? localName(iri) }))
}

export function loadMap(ttl, { hideUnmappedFields = true, hideUnmappedTargetFields = true, hiddenSources } = {}) {
    // Render target-predicate IRIs like `schema:identifier` (instead of the
    // local TargetField name) using the federation's own @prefix declarations.
    const prefixes = { cdp: NS, ...prefixesOf(ttl) }
    const prefixedIri = (iri) => shrink(iri, prefixes)
    const quads = parseTtl(ttl)

    const typeOf = typesOf(quads)

    const nodeSet = new Set()
    for (const [iri, types] of typeOf) {
        if (NODE_TYPES.some((t) => types.has(t)) || types.has(SUB_FIELD)) nodeSet.add(iri)
    }

    const edges = []
    const push = (from, to, label, extra) => {
        if (nodeSet.has(from) && nodeSet.has(to)) edges.push({ from, to, label, ...extra })
    }

    // :from and :to on a field-mapping blank node can each carry multiple
    // values (comma-list in turtle), so track them as arrays. :via is
    // single-valued — it names a transform of the mapping's source
    // (sources/<source>/transform-<via>.sparql), rendered as its own node.
    const bnodeFrom = new Map()
    const bnodeTo   = new Map()
    const bnodeVia  = new Map()
    const fromSourceOf = new Map()
    const appendTo = (map, key, val) => {
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(val)
    }
    const targetPredicate = new Map()
    const fieldPath = new Map()
    for (const q of quads) {
        if (q.predicate.value === `${NS}hasField`)         push(q.subject.value, q.object.value, "hasField")
        else if (q.predicate.value === `${NS}hasSubField`) push(q.subject.value, q.object.value, "hasSubField")
        else if (q.predicate.value === `${NS}hasTargetField`) push(q.object.value, q.subject.value, "isTargetFieldOf")
        else if (q.predicate.value === `${NS}from`) appendTo(bnodeFrom, q.subject.value, q.object.value)
        else if (q.predicate.value === `${NS}to`)   appendTo(bnodeTo,   q.subject.value, q.object.value)
        else if (q.predicate.value === `${NS}via`)  bnodeVia.set(q.subject.value, q.object.value)
        else if (q.predicate.value === `${NS}fromSource`) fromSourceOf.set(q.subject.value, q.object.value)
        else if (q.predicate.value === `${NS}targetPredicate`) targetPredicate.set(q.subject.value, q.object.value)
        else if (q.predicate.value === `${NS}fieldPath`) fieldPath.set(q.subject.value, q.object.value)
    }
    // Deduplicate routed edges: the same (source, via) or (via, target) pair
    // can appear across multiple field-mappings sharing one transform node.
    const seen = new Set()
    const pushOnce = (f, t, label, extra) => {
        const k = `${f}|${label}|${t}`
        if (seen.has(k)) return
        seen.add(k)
        push(f, t, label, extra)
    }
    const transformLabel = new Map()  // minted node id -> "source/via" label
    for (const q of quads) {
        if (q.predicate.value === `${NS}hasFieldMapping`) {
            const froms = bnodeFrom.get(q.object.value) ?? []
            const tos   = bnodeTo.get(q.object.value)   ?? []
            const viaName = bnodeVia.get(q.object.value)
            if (viaName) {
                const name = sourceName(fromSourceOf.get(q.subject.value))
                const via = `transform:${name}:${viaName}`
                if (!transformLabel.has(via)) { transformLabel.set(via, `${name}/${viaName}`); nodeSet.add(via) }
                for (const f of froms) pushOnce(f, via, "mapsTo")
                for (const t of tos)   pushOnce(via, t, "mapsTo")
            } else {
                for (const f of froms) for (const t of tos) pushOnce(f, t, "mapsTo", { direct: true })
            }
        }
    }

    // SubFields render in the SourceField column — they're just nested fields.
    const typeFor = (iri) => {
        if (transformLabel.has(iri)) return "TransformNode"
        const ts = typeOf.get(iri)
        if (ts?.has(SUB_FIELD)) return "SourceField"
        for (const t of NODE_TYPES) if (ts?.has(t)) return localName(t)
        return "Node"
    }

    // Keep only nodes forward-reachable from a visible source. Fixed-point
    // pass over `edges` until no new node is added.
    if (hiddenSources?.size) {
        const reachable = new Set([...nodeSet].filter((iri) =>
            typeOf.get(iri)?.has(`${NS}Source`) && !hiddenSources.has(iri)))
        for (let grew = true; grew;) {
            grew = false
            for (const e of edges) if (reachable.has(e.from) && !reachable.has(e.to)) { reachable.add(e.to); grew = true }
        }
        for (const iri of [...nodeSet]) if (!reachable.has(iri)) nodeSet.delete(iri)
    }

    // Track mapped-ness on both ends of mapsTo edges. Source fields are mapped
    // when they appear as `from`; target fields when they appear as `to`. Sub-
    // field parents inherit mapped-ness from any of their sub-fields. Unmapped
    // nodes are either hidden or tagged dashed for the caller to style.
    const mappedSources = new Set()
    const mappedTargets = new Set()
    for (const e of edges) if (e.label === "mapsTo") { mappedSources.add(e.from); mappedTargets.add(e.to) }
    for (const e of edges) if (e.label === "hasSubField" && mappedSources.has(e.to)) mappedSources.add(e.from)
    const isField = (iri) => {
        const ts = typeOf.get(iri)
        return ts?.has(`${NS}SourceField`) || ts?.has(SUB_FIELD)
    }
    const isTargetField = (iri) => typeOf.get(iri)?.has(`${NS}TargetField`) ?? false

    if (hideUnmappedFields) {
        for (const iri of [...nodeSet]) if (isField(iri) && !mappedSources.has(iri)) nodeSet.delete(iri)
    }
    if (hideUnmappedTargetFields) {
        for (const iri of [...nodeSet]) if (isTargetField(iri) && !mappedTargets.has(iri)) nodeSet.delete(iri)
    }
    const visibleEdges = edges.filter((e) => nodeSet.has(e.from) && nodeSet.has(e.to))

    const labelFor = (iri) => {
        const tl = transformLabel.get(iri)
        if (tl) return tl
        const tp = targetPredicate.get(iri)
        if (tp) return prefixedIri(tp)
        const fp = fieldPath.get(iri)
        if (fp) return fp
        return localName(iri)
    }

    const nodes = [...nodeSet].map((iri) => ({
        id: iri,
        label: labelFor(iri),
        type: typeFor(iri),
        ...(((isField(iri) && !mappedSources.has(iri)) || (isTargetField(iri) && !mappedTargets.has(iri))) && { dashed: true }),
    }))
    return { nodes, edges: visibleEdges }
}
