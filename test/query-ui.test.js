import { buildSparnaturalConfig, buildSparnaturalQuery } from "../webapp/src/sparnaturalConfig.js"
import { formatSparql } from "../webapp/src/formatSparql.js"
import { readQueryExamples } from "../webapp/src/queryExamples.js"
import { bindingsToJson } from "../webapp/src/queryResults.js"
import { createQueryRunner } from "../webapp/src/queryRunner.js"
import { queryEngine } from "@foerderfunke/sem-ops-utils/sparql"
import { Store } from "n3"
import { NAMESPACES, parseTtl } from "../src/utils.js"
import assert from "node:assert/strict"
import { test } from "node:test"

const SH = "http://www.w3.org/ns/shacl#"
const DASH = "http://datashapes.org/dash#"
const CORE = "http://data.sparna.fr/ontologies/sparnatural-config-core#"

test("Query loads the complete directory once on demand and keeps all SPARQL result types", async () => {
    const turtle = `@prefix schema: <${NAMESPACES.schema}> . @prefix xsd: <${NAMESPACES.xsd}> .
        <urn:service> schema:provider <urn:organisation> .
        <urn:organisation> schema:name "Advice"@en ; schema:address <urn:address> .
        <urn:address> schema:latitude "52.5"^^xsd:double .`
    let reads = 0
    const runner = createQueryRunner(async () => { reads++; return turtle })
    const progress = []
    assert.equal(reads, 0)
    const [select, ask, hints] = await Promise.all([
        runner.run(`SELECT ?name WHERE { <urn:service> <${NAMESPACES.schema}provider>/<${NAMESPACES.schema}name> ?name }`, status => progress.push(status)),
        runner.run("ASK { <urn:address> ?p ?o }"),
        runner.datatypes(),
    ])
    assert.equal(reads, 1)
    assert.deepEqual(progress, ["Loading directory…", "Running query…"])
    assert.deepEqual(JSON.parse(select.body).results.bindings, [{ name: { type: "literal", value: "Advice", "xml:lang": "en" } }])
    assert.equal(JSON.parse(ask.body).boolean, true)
    assert.equal(hints[`${NAMESPACES.schema}latitude`], `${NAMESPACES.xsd}double`)
    progress.length = 0
    const construct = await runner.run("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }", status => progress.push(status))
    assert.deepEqual(progress, ["Running query…"])
    assert.equal(construct.contentType, "text/turtle")
    assert.equal(parseTtl(construct.body).length, 4)
    await assert.rejects(runner.run("not SPARQL"))
    assert.equal(JSON.parse((await runner.run("ASK {}")).body).boolean, true)
    assert.equal(reads, 1)
})

test("Query retries a failed directory load", async () => {
    let reads = 0
    const progress = []
    const report = status => progress.push(status)
    const runner = createQueryRunner(async () => {
        if (++reads === 1) throw new Error("fetch failed")
        return '<urn:a> <urn:b> "c" .'
    })
    await assert.rejects(runner.run("ASK {}", report), /fetch failed/)
    assert.equal(JSON.parse((await runner.run("ASK { ?s ?p ?o }", report)).body).boolean, true)
    assert.deepEqual(progress, ["Loading directory…", "Loading directory…", "Running query…"])
    assert.equal(reads, 2)
})

test("query results retain selected columns for empty and unbound results", async () => {
    const store = new Store(parseTtl('<https://example.org/entry> <http://schema.org/name> "Example" .'))
    const run = async (query) => bindingsToJson(await queryEngine.query(query, { sources: [store] }))
    assert.deepEqual(await run("SELECT DISTINCT ?value WHERE { ?entry <http://purl.org/dc/terms/modified> ?value } LIMIT 25"), {
        head: { vars: ["value"] }, results: { bindings: [] },
    })
    assert.deepEqual(await run(`SELECT ?missing ?name WHERE {
        ?entry <http://schema.org/name> ?name .
        OPTIONAL { ?entry <http://purl.org/dc/terms/modified> ?missing }
    }`), {
        head: { vars: ["missing", "name"] },
        results: { bindings: [{ name: { type: "literal", value: "Example" } }] },
    })
})

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
