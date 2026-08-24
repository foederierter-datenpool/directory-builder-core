import { buildSparnaturalConfig, buildSparnaturalQuery } from "../webapp/src/sparnaturalConfig.js"
import { formatSparql } from "../webapp/src/formatSparql.js"
import { readQueryExamples } from "../webapp/src/queryExamples.js"
import { NAMESPACES, parseTtl } from "../src/utils.js"
import assert from "node:assert/strict"
import { test } from "node:test"

const SH = "http://www.w3.org/ns/shacl#"
const DASH = "http://datashapes.org/dash#"
const CORE = "http://data.sparna.fr/ontologies/sparnatural-config-core#"

test("visual SPARQL uses readable prefixes, groups and indentation", () => {
    const query = `PREFIX schema: <http://schema.org/> SELECT ?service ?name WHERE {
?service a schema:Service. OPTIONAL { ?service schema:name ?name. }
} LIMIT 100`

    assert.equal(formatSparql(query), `PREFIX schema: <http://schema.org/>

SELECT ?service ?name WHERE {
    ?service a schema:Service.
    OPTIONAL {
        ?service schema:name ?name.
    }
}
LIMIT 100`)
})

test("query examples keep their declared order and preferred label", () => {
    const examples = readQueryExamples(`
        @prefix : <https://example.org/> .
        @prefix cdp: <https://civic-data.de/pipeline#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        :second a cdp:QueryExample ; cdp:order 2 ; rdfs:label "Second"@en ; cdp:query "SELECT * {}" .
        :first a cdp:QueryExample ; cdp:order 1 ; rdfs:label "Erste"@de, "First"@en ; cdp:query "ASK {}" .
        :visual a cdp:QueryExample ; cdp:order 3 ; rdfs:label "Visual"@en ;
            cdp:visualFrom :serviceSchema ;
            cdp:visualBranch
                [ cdp:visualThrough :provider ; cdp:visualTo :organisationSchema ],
                [ cdp:visualThrough :address ; cdp:visualTo :addressSchema ] .
    `)

    assert.deepEqual(examples.map(({ name, query, visual }) => ({ name, query, visual })), [
        { name: "First", query: "ASK {}", visual: undefined },
        { name: "Second", query: "SELECT * {}", visual: undefined },
        { name: "Visual", query: undefined, visual: {
            fromSchema: "https://example.org/serviceSchema",
            branches: [
                {
                    throughField: "https://example.org/provider",
                    toSchema: "https://example.org/organisationSchema",
                },
                {
                    throughField: "https://example.org/address",
                    toSchema: "https://example.org/addressSchema",
                },
            ],
        } },
    ])
})

test("Sparnatural config follows target fields and declared relationships", () => {
    const federation = `
        @prefix : <https://civic-data.de/pipeline#> .
        @prefix schema: <http://schema.org/> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        :federation :hasTargetSchema :serviceSchema, :organisationSchema .
        :serviceSchema :targetClass schema:Service ; rdfs:label "Angebot"@de ;
            :hasTargetField :name, :provider, :funder .
        :organisationSchema :targetClass schema:Organization ; rdfs:label "Träger"@de ;
            :hasTargetField :name .
        :name :targetPredicate schema:name .
        :provider :targetPredicate schema:provider .
        :funder :targetPredicate schema:funder .
        :mapping :toTarget :serviceSchema ; :hasRelationship
            [ :toTargetField :provider ; :toTargetSchema :organisationSchema ],
            [ :toTargetField :funder ; :toTargetSchema :organisationSchema ] .
    `
    const final = `
        @prefix schema: <http://schema.org/> .
        <https://example.org/service> a schema:Service ; schema:name "Advice" ;
            schema:provider <https://example.org/organisation> .
    `
    const quads = parseTtl(buildSparnaturalConfig(federation, final))
    const nodeShapes = quads.filter((quad) =>
        quad.predicate.value === `${NAMESPACES.rdf}type` && quad.object.value === `${SH}NodeShape`)
    assert.equal(nodeShapes.length, 2)

    const nameShape = quads.find((quad) =>
        quad.predicate.value === `${SH}path` && quad.object.value === `${NAMESPACES.schema}name`)?.subject.value
    assert.ok(nameShape)
    assert.ok(quads.some((quad) => quad.subject.value === nameShape
        && quad.predicate.value === `${DASH}propertyRole` && quad.object.value === `${DASH}LabelRole`))

    const providerShape = quads.find((quad) =>
        quad.predicate.value === `${SH}path` && quad.object.value === `${NAMESPACES.schema}provider`)?.subject.value
    assert.ok(providerShape)
    assert.ok(quads.some((quad) => quad.subject.value === providerShape
        && quad.predicate.value === `${SH}class` && quad.object.value === `${NAMESPACES.schema}Organization`))
    assert.ok(quads.some((quad) => quad.subject.value === providerShape
        && quad.predicate.value === `${DASH}searchWidget` && quad.object.value === `${CORE}NonSelectableProperty`))

    const visual = buildSparnaturalQuery(federation, {
        fromSchema: "https://civic-data.de/pipeline#serviceSchema",
        branches: [
            {
                throughField: "https://civic-data.de/pipeline#provider",
                toSchema: "https://civic-data.de/pipeline#organisationSchema",
            },
            {
                throughField: "https://civic-data.de/pipeline#funder",
                toSchema: "https://civic-data.de/pipeline#organisationSchema",
            },
        ],
    })
    assert.deepEqual(visual.variables.map(({ value }) => value), [
        "service",
        "organisation_provider",
        "organisation_funder",
    ])
    assert.deepEqual(visual.where.predicateObjectPairs.map(({ predicate }) => predicate.value), [
        "https://civic-data.de/pipeline/sparnatural#serviceSchema_provider_organisationSchema_1",
        "https://civic-data.de/pipeline/sparnatural#serviceSchema_funder_organisationSchema_1",
    ])
})
