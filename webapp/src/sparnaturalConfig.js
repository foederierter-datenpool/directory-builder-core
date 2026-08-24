import { CDP, localName, NAMESPACES, parseTtl } from "@directory-builder/core/utils"

const RDFS_LABEL = `${NAMESPACES.rdfs}label`
const XSD_STRING = `${NAMESPACES.xsd}string`
const SHAPE_NS = "https://civic-data.de/pipeline/sparnatural#"

const termsOf = (quads, subject, predicate) => quads
    .filter((quad) => quad.subject.value === subject && quad.predicate.value === predicate)
    .map((quad) => quad.object)

const firstValue = (quads, subject, predicate) => termsOf(quads, subject, predicate)[0]?.value
const valuesOf = (quads, subject, predicate) => termsOf(quads, subject, predicate).map((term) => term.value)

const humanize = (value) => {
    const words = value
        .replace(/Schema$/i, "")
        .replace(/^t-/, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[-_]+/g, " ")
    return words.charAt(0).toUpperCase() + words.slice(1)
}

const labelOf = (quads, subject, fallback) => {
    const labels = termsOf(quads, subject, RDFS_LABEL)
    return labels.find((term) => term.language === "en")?.value
        ?? labels.find((term) => !term.language)?.value
        ?? labels[0]?.value
        ?? humanize(localName(fallback))
}

const shapeName = (iri) => localName(iri).replace(/[^a-zA-Z0-9_-]/g, "-")
const shapeIri = (schema) => `${SHAPE_NS}${shapeName(schema)}`
const propertyShapeIri = (schema, field, range, index) =>
    `${shapeIri(schema)}_${shapeName(field)}${range ? `_${shapeName(range)}` : ""}_${index}`
const iri = (value) => `<${value}>`
const literal = (value) => JSON.stringify(value)

const queryVariable = (value, rdfType) => ({
    type: "term",
    subType: "variable",
    value,
    ...(rdfType ? { rdfType } : {}),
})
const namedNode = (value) => ({ type: "term", subType: "namedNode", value })
const variableName = (iri) => localName(iri)
    .replace(/Schema$/i, "")
    .replace(/^t-/, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word, index) => index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1))
    .join("")

const uniqueVariable = (base, usedVariables) => {
    let variable = base
    let suffix = 2
    while (usedVariables.has(variable)) {
        variable = `${base}_${suffix}`
        suffix += 1
    }
    usedVariables.add(variable)
    return variable
}

const datatypeByPredicate = (finalQuads) => {
    const datatypes = new Map()
    for (const quad of finalQuads) {
        if (quad.object.termType !== "Literal") continue
        if (!datatypes.has(quad.predicate.value)) datatypes.set(quad.predicate.value, new Set())
        datatypes.get(quad.predicate.value).add(quad.object.datatype.value)
    }
    return new Map([...datatypes].map(([predicate, values]) =>
        [predicate, values.size === 1 ? [...values][0] : XSD_STRING]))
}

const relationshipRanges = (quads) => {
    const ranges = new Map()
    for (const mappingQuad of quads.filter((quad) => quad.predicate.value === `${CDP}hasRelationship`)) {
        const mapping = mappingQuad.subject.value
        const relationship = mappingQuad.object.value
        const fromSchema = firstValue(quads, mapping, `${CDP}toTarget`)
        const field = firstValue(quads, relationship, `${CDP}toTargetField`)
        const toSchema = firstValue(quads, relationship, `${CDP}toTargetSchema`)
        if (!fromSchema || !field || !toSchema) continue

        const key = `${fromSchema}\n${field}`
        if (!ranges.has(key)) ranges.set(key, new Set())
        ranges.get(key).add(toSchema)
    }
    return ranges
}

const literalWidget = (datatype) => {
    if (datatype === `${NAMESPACES.xsd}date`) return "core:TimeProperty-Date"
    if (["integer", "decimal", "double", "float"].some((type) => datatype === `${NAMESPACES.xsd}${type}`))
        return "core:NumberProperty"
    return "core:SearchProperty"
}

const buildProperty = ({ id, predicate, label, order, rangeClass, datatype, labelRole }) => {
    const valueShape = rangeClass
        ? `    sh:nodeKind sh:IRI ;\n    sh:class ${iri(rangeClass)} ;\n    dash:searchWidget core:NonSelectableProperty`
        : `    sh:nodeKind sh:Literal ;\n    sh:datatype ${iri(datatype)} ;\n    dash:searchWidget ${literalWidget(datatype)}`
    return `${iri(id)} sh:path ${iri(predicate)} ;
    sh:order ${order} ;
    sh:name ${literal(label)}@en ;
${valueShape}${labelRole ? " ;\n    dash:propertyRole dash:LabelRole" : ""} .`
}

export function buildSparnaturalConfig(federationTtl, finalTtl = "") {
    if (!federationTtl) return ""
    const quads = parseTtl(federationTtl)
    const finalQuads = parseTtl(finalTtl)
    const schemas = valuesOf(quads, `${CDP}federation`, `${CDP}hasTargetSchema`)
    const ranges = relationshipRanges(quads)
    const datatypes = datatypeByPredicate(finalQuads)
    const schemaLabels = new Map(schemas.map((schema) => {
        const targetClass = firstValue(quads, schema, `${CDP}targetClass`) ?? schema
        return [schema, labelOf(quads, schema, targetClass)]
    }))

    const shapes = []
    const properties = []
    schemas.forEach((schema, schemaIndex) => {
        const targetClass = firstValue(quads, schema, `${CDP}targetClass`)
        if (!targetClass) return

        const propertyIds = []
        const fields = valuesOf(quads, schema, `${CDP}hasTargetField`)
        fields.forEach((field, fieldIndex) => {
            const predicate = firstValue(quads, field, `${CDP}targetPredicate`)
            if (!predicate) return
            const targets = [...(ranges.get(`${schema}\n${field}`) ?? [])]
            const variants = targets.length ? targets : [null]
            variants.forEach((range, variantIndex) => {
                const id = propertyShapeIri(schema, field, range, variantIndex + 1)
                const rangeSuffix = targets.length > 1 ? ` (${schemaLabels.get(range) ?? humanize(localName(range))})` : ""
                propertyIds.push(id)
                properties.push(buildProperty({
                    id,
                    predicate,
                    label: `${humanize(localName(predicate))}${rangeSuffix}`,
                    order: fieldIndex + 1,
                    rangeClass: range ? firstValue(quads, range, `${CDP}targetClass`) : null,
                    datatype: datatypes.get(predicate) ?? XSD_STRING,
                    labelRole: localName(predicate).toLowerCase() === "name",
                }))
            })
        })

        shapes.push(`${iri(shapeIri(schema))} a sh:NodeShape ;
    sh:targetClass ${iri(targetClass)} ;
    sh:order ${schemaIndex + 1} ;
    rdfs:label ${literal(schemaLabels.get(schema))}@en${propertyIds.length
        ? ` ;\n    sh:property ${propertyIds.map(iri).join(", ")}`
        : ""} .`)
    })

    if (!shapes.length) return ""
    return `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix dash: <http://datashapes.org/dash#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix core: <http://data.sparna.fr/ontologies/sparnatural-config-core#> .

${shapes.join("\n\n")}

${properties.join("\n\n")}
`
}

// Turn a readable one-hop schema path from query-examples.ttl into the
// structured query format consumed by Sparnatural.loadQuery(). The property
// shape calculation is shared with the config generator, so examples cannot
// drift from relationship variants such as Service -> Facility/Organisation.
export function buildSparnaturalQuery(federationTtl, visualPath) {
    if (!federationTtl || !visualPath) return null
    const { fromSchema, branches } = visualPath
    const quads = parseTtl(federationTtl)
    const fromClass = firstValue(quads, fromSchema, `${CDP}targetClass`)
    if (!fromClass || !branches?.length) return null

    const fromVariable = variableName(fromSchema)
    const rangesByRelationship = relationshipRanges(quads)
    const targetNames = branches.map(({ toSchema }) => variableName(toSchema))
    const targetNameCounts = new Map()
    for (const name of targetNames) {
        targetNameCounts.set(name, (targetNameCounts.get(name) ?? 0) + 1)
    }
    const usedVariables = new Set([fromVariable])

    const compiledBranches = branches.map(({ throughField, toSchema }) => {
        const ranges = [...(rangesByRelationship.get(`${fromSchema}\n${throughField}`) ?? [])]
        const rangeIndex = ranges.indexOf(toSchema)
        const toClass = firstValue(quads, toSchema, `${CDP}targetClass`)
        if (rangeIndex < 0 || !toClass) return null

        const targetName = variableName(toSchema)
        const needsRole = targetName === fromVariable || targetNameCounts.get(targetName) > 1
        const variableBase = needsRole ? `${targetName}_${variableName(throughField)}` : targetName
        const toVariable = uniqueVariable(variableBase, usedVariables)

        return {
            variable: toVariable,
            pair: {
                type: "predicateObjectPair",
                predicate: namedNode(propertyShapeIri(
                    fromSchema,
                    throughField,
                    toSchema,
                    rangeIndex + 1,
                )),
                object: {
                    type: "objectCriteria",
                    variable: queryVariable(toVariable, shapeIri(toSchema)),
                    filters: [],
                },
            },
        }
    })
    if (compiledBranches.some((branch) => !branch)) return null

    return {
        type: "query",
        subType: "SELECT",
        distinct: true,
        variables: [
            queryVariable(fromVariable),
            ...compiledBranches.map(({ variable }) => queryVariable(variable)),
        ],
        solutionModifiers: {
            limitOffset: { type: "solutionModifier", subType: "limitOffset", limit: 100 },
        },
        where: {
            type: "pattern",
            subType: "bgpSameSubject",
            subject: queryVariable(fromVariable, shapeIri(fromSchema)),
            predicateObjectPairs: compiledBranches.map(({ pair }) => pair),
        },
    }
}
