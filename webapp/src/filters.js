// Schema-filter options for the Merge and Directory views.
// Reads:  federation.ttl.
// Does:   one option per :TargetSchema, keyed to match entity.type.

import { CDP as NS, parseTtl, prefixesOf, shrink } from "@directory-builder/core/utils"

const RDFS_LABEL   = "http://www.w3.org/2000/01/rdf-schema#label"
const TARGET_CLASS = `${NS}targetClass`

// One option per :TargetSchema, in declaration order. `type` is the prefixed
// targetClass — the same form loadMerge stores in entity.type — so a checkbox can
// test `selected.has(entity.type)` directly. `label` is the schema's rdfs:label.
export function schemaOptions(federationTtl) {
    const prefixes = { cdp: NS, ...prefixesOf(federationTtl) }
    const label = new Map(), cls = new Map()
    for (const { subject, predicate, object } of parseTtl(federationTtl)) {
        if (predicate.value === RDFS_LABEL && !label.has(subject.value)) label.set(subject.value, object.value)
        else if (predicate.value === TARGET_CLASS) cls.set(subject.value, object.value)
    }
    return [...cls].map(([schema, c]) => ({ label: label.get(schema) ?? shrink(c, prefixes), type: shrink(c, prefixes) }))
}
