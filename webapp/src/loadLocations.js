// Builds the geographic map from resolved entities and the relationships the
// federation declares to its PostalAddress schema.

import { CDP, groupBySubject, localName, NAMESPACES, parseTtl, prefixesOf, shrink } from "@directory-builder/core/utils"

const { rdf: RDF, rdfs: RDFS, schema: SCHEMA } = NAMESPACES
const RDF_TYPE = `${RDF}type`
const TARGET_SCHEMA = `${CDP}TargetSchema`
const TARGET_CLASS = `${CDP}targetClass`
const TARGET_PREDICATE = `${CDP}targetPredicate`
const TO_TARGET_FIELD = `${CDP}toTargetField`
const TO_TARGET_SCHEMA = `${CDP}toTargetSchema`
const POSTAL_ADDRESS = `${SCHEMA}PostalAddress`

const objectValue = (quads, subject, predicate) => quads
    .find((quad) => quad.subject.value === subject && quad.predicate.value === predicate)
    ?.object.value

const subjectsWith = (quads, predicate, object) => quads
    .filter((quad) => quad.predicate.value === predicate && quad.object.value === object)
    .map((quad) => quad.subject.value)

const turtleEntry = (turtle, iri) => {
    const compact = shrink(iri, prefixesOf(turtle))
    const subject = compact === iri ? `<${iri}>` : compact
    const lines = turtle.split("\n")
    const startsEntry = (line) => line.trimStart().startsWith(`${subject} `)
    const endsEntry = (line) => line.trimEnd().endsWith(".")
    const start = lines.findIndex(startsEntry)
    if (start < 0) return ""

    let end = start
    while (end < lines.length - 1 && !endsEntry(lines[end])) end++
    return lines.slice(start, end + 1).join("\n").trimStart()
}

export function loadLocations(finalTtl, federationTtl) {
    const data = parseTtl(finalTtl)
    const config = parseTtl(federationTtl)
    const schemas = subjectsWith(config, RDF_TYPE, TARGET_SCHEMA)
    const classBySchema = new Map(schemas
        .map((schema) => [schema, objectValue(config, schema, TARGET_CLASS)])
        .filter(([, targetClass]) => targetClass))
    const labelByClass = new Map([...classBySchema].map(([schema, targetClass]) => [
        targetClass,
        objectValue(config, schema, `${RDFS}label`) ?? localName(targetClass),
    ]))
    const addressSchema = schemas.find((schema) => classBySchema.get(schema) === POSTAL_ADDRESS)
    if (!addressSchema) return []

    const relationshipFields = new Set(subjectsWith(config, TO_TARGET_SCHEMA, addressSchema)
        .map((relationship) => objectValue(config, relationship, TO_TARGET_FIELD))
        .filter(Boolean))
    const addressPredicates = new Set(config
        .filter((quad) => quad.predicate.value === TARGET_PREDICATE && relationshipFields.has(quad.subject.value))
        .map((quad) => quad.object.value))
    const addressIris = new Set(subjectsWith(data, RDF_TYPE, POSTAL_ADDRESS))
    const valuesBySubject = groupBySubject(data)
    const firstValue = (subject, predicate) => valuesBySubject.get(subject)?.get(predicate)?.[0]
    const entityIrisByAddress = new Map()

    for (const quad of data) {
        const addressIri = quad.object.value
        if (!addressIris.has(addressIri) || !addressPredicates.has(quad.predicate.value)) continue
        const entityIris = entityIrisByAddress.get(addressIri) ?? new Set()
        entityIris.add(quad.subject.value)
        entityIrisByAddress.set(addressIri, entityIris)
    }

    const loadEntity = (iri) => {
        const typeIri = firstValue(iri, RDF_TYPE)
        const label = firstValue(iri, `${SCHEMA}name`) ?? firstValue(iri, `${RDFS}label`) ?? localName(iri)
        const type = labelByClass.get(typeIri) ?? (typeIri ? localName(typeIri) : "Entity")
        return { iri, label, type, turtle: turtleEntry(finalTtl, iri) }
    }
    const loadAddress = (iri) => {
        const latitude = Number(firstValue(iri, `${SCHEMA}latitude`))
        const longitude = Number(firstValue(iri, `${SCHEMA}longitude`))
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

        const street = firstValue(iri, `${SCHEMA}streetAddress`)
        const postalCode = firstValue(iri, `${SCHEMA}postalCode`)
        const locality = firstValue(iri, `${SCHEMA}addressLocality`)
        const country = firstValue(iri, `${SCHEMA}addressCountry`)
        const city = [postalCode, locality].filter(Boolean).join(" ")
        const lines = [street, city, country].filter(Boolean)
        const entities = [...(entityIrisByAddress.get(iri) ?? [])]
            .map(loadEntity)
            .sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label))
        if (!entities.length) return null
        return { iri, latitude, longitude, lines, label: lines.join(", ") || localName(iri), entities }
    }

    return [...addressIris]
        .map(loadAddress)
        .filter(Boolean)
        .sort((a, b) => a.label.localeCompare(b.label))
}
