import { buildTargetVocabulary } from "../src/target-vocabulary.js"
import { loadVocabulary } from "../webapp/src/loadVocabulary.js"
import { loadPipeline } from "../webapp/src/loadPipeline.js"
import { Pipeline } from "../src/pipeline.js"
import { parseTtl, PATHS, CDP } from "../src/utils.js"
import { buildValidator, turtleToDataset } from "@foerderfunke/sem-ops-utils"
import { makeInstance } from "./helpers/instance.js"
import { Store } from "n3"
import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"

const SH = "http://www.w3.org/ns/shacl#"
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
const SCHEMA = "http://schema.org/"
const PREFIXES = `
@prefix : <https://civic-data.de/pipeline#> .
@prefix schema: <http://schema.org/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ft: <http://publications.europa.eu/resource/authority/file-type/> .
`
const profile = `${PREFIXES}
schema:name rdfs:label "name"@en ; rdfs:comment "The name of the item."@en .
:serviceSchema a :TargetSchema ; :targetClass schema:Service ;
    rdfs:label "Angebot"@de ; :hasTargetField :name, :provider, :description .
:name a :TargetField ; :targetPredicate schema:name ;
    sh:name "Service name"@en ; rdfs:comment "Name displayed in the directory."@en ;
    sh:datatype xsd:string ; sh:minCount 1 ; sh:maxCount 1 ; sh:pattern "^[A-Z]" ; :typeDerivation :adopted .
:provider a :TargetField ; :targetPredicate schema:provider ; sh:nodeKind sh:IRI ;
    sh:or ( [ sh:class schema:Organization ] [ sh:node :personShape ] ) .
:personShape a sh:NodeShape ; sh:class schema:Person .
:description a :TargetField ; :targetPredicate schema:description .
:enrich a :EnrichRule ; :geocode :serviceSchema .
`

test("vocabulary generation is deterministic and preserves optional, nested and named SHACL rules", async () => {
    const generated = await buildTargetVocabulary(profile)
    // Other parsers' blank-node allocations must not leak into generated files.
    parseTtl(`${PREFIXES} :unrelated :value [ :nested [] ] .`)
    assert.deepEqual(await buildTargetVocabulary(profile), generated)
    const vocabulary = new Store(parseTtl(generated))
    assert.equal(vocabulary.countQuads(SCHEMA + "Service", RDF + "type", "http://www.w3.org/2000/01/rdf-schema#Class", null), 1)
    assert.equal(vocabulary.countQuads(SCHEMA + "provider", RDF + "type", RDF + "Property", null), 0)
    assert.equal(vocabulary.countQuads(CDP + "provider", SH + "path", SCHEMA + "provider", null), 1)
    assert.equal(vocabulary.countQuads(SCHEMA + "name", RDF + "type", RDF + "Property", null), 1, "documented properties keep their declarations")
    for (const coordinate of ["latitude", "longitude"])
        assert.equal(vocabulary.countQuads(SCHEMA + coordinate, RDF + "type", RDF + "Property", null), 1, "enrichment-only properties stay visible")
    assert.equal(vocabulary.countQuads(null, "http://www.w3.org/2000/01/rdf-schema#range", null, null), 0)
    assert.equal(vocabulary.countQuads(CDP + "description", SH + "datatype", null, null), 0)
    assert.equal(vocabulary.countQuads(CDP + "name", CDP + "typeDerivation", CDP + "adopted", null), 1)
    const rdfs = "http://www.w3.org/2000/01/rdf-schema#"
    assert.equal(vocabulary.getObjects(SCHEMA + "name", rdfs + "comment", null)[0].value, "The name of the item.")
    assert.equal(vocabulary.getObjects(CDP + "name", rdfs + "comment", null)[0].value, "Name displayed in the directory.")
    assert.equal(vocabulary.getObjects(CDP + "name", SH + "name", null)[0].value, "Service name")
    assert.equal(vocabulary.countQuads(SCHEMA + "Service", rdfs + "label", null, null), 0, "local schema labels stay on shapes")
    const validator = buildValidator(generated)
    const check = async (data) => (await validator.validate({ dataset: turtleToDataset(PREFIXES + data) })).conforms
    for (const cls of ["Organization", "Person"])
        assert.equal(await check(`:s a schema:Service ; schema:name "Advice" ; schema:provider :p ; schema:extra 123 . :p a schema:${cls}.`), true)
    assert.equal(await check(':s a schema:Service ; schema:name "Advice" ; schema:description 123 .'), true)
    assert.equal(await check(':s a schema:Service .'), false, "minCount survives generation")
    assert.equal(await check(':s a schema:Service ; schema:name "Advice", "More" .'), false, "maxCount survives generation")
    assert.equal(await check(':s a schema:Service ; schema:name "lowercase" .'), false, "pattern survives generation")
    assert.equal(await check(':s a schema:Service ; schema:name 42 .'), false, "datatype survives generation")
    assert.equal(await check(':s a schema:Service ; schema:name "Advice" ; schema:provider [ a schema:Organization ] .'), false, "IRI kind survives generation")
    assert.equal(await check(':s a schema:Service ; schema:name "Advice" ; schema:provider :p . :p a schema:Place .'), false, "OR classes survive generation")
})

test("the Vocabulary page uses the published profile or generates it from config", async () => {
    const generated = await buildTargetVocabulary(profile)
    const published = await buildTargetVocabulary(profile.replace('"Angebot"@de', '"Published offer"@en'))
    assert.equal(await loadVocabulary(profile, async (file) => {
        assert.equal(file, PATHS.targetVocabulary)
        return published
    }), published)
    assert.equal(await loadVocabulary(profile, async () => ""), generated)
})

test("Turtle sections follow configured schemas and keep shared fields and enrichment separate", async () => {
    const config = `${profile}
        :federation a :Federation ; :hasTargetSchema :organisationSchema, :serviceSchema .
        :organisationSchema a :TargetSchema ; :targetClass schema:Organization ; :hasTargetField :name .`
    const generated = await buildTargetVocabulary(config)
    const headings = [...generated.matchAll(/^# ---- (.*?) -+$/gm)].map((match) => match[1])
    assert.deepEqual(headings, ["schema:Organization", "Angebot (schema:Service)",
        "Shared fields", "Enrichment properties", "Supporting definitions"])
    const sections = generated.split(/^# ---- .*$/m)
    assert.match(sections[1], /schema:Organization a rdfs:Class/)
    assert.match(sections[2], /schema:Service a rdfs:Class/)
    assert.match(sections[2], /sh:targetClass schema:Service\.\n\n:description a sh:PropertyShape/)
    assert.match(sections[2], /:provider a sh:PropertyShape/)
    assert.match(sections[3], /:name a sh:PropertyShape/)
    assert.match(sections[4], /schema:latitude a rdf:Property/)
    assert.match(sections[5], /:personShape a sh:NodeShape/)
    assert.equal(generated.match(/:name a sh:PropertyShape/g).length, 1)
    const graph = new Store(parseTtl(generated))
    for (const schema of ["organisationSchema", "serviceSchema"])
        assert.equal(graph.countQuads(CDP + schema, SH + "property", CDP + "name", null), 1)
    assert.equal(await buildTargetVocabulary(config), generated)
})

test("the vocabulary command needs only federation.ttl and writes one combined artifact", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "directory-vocabulary-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.mkdirSync(path.join(root, "config"))
    fs.writeFileSync(path.join(root, PATHS.federation), profile)
    execFileSync(process.execPath, [path.join(import.meta.dirname, "../bin/cli.js"), "vocabulary"], { cwd: root })
    const generated = await buildTargetVocabulary(profile)
    assert.equal(artifact(root, PATHS.targetVocabulary), generated)
    assert.deepEqual(fs.readdirSync(path.join(root, "data")), ["target-vocabulary.ttl"])
})

// No hasTargetField list: mapping-only legacy config must still attach rules
// to its target class. The identifier has no SHACL annotations at all.
const pipelineConfig = `${PREFIXES}
:federation a :Federation ; :hasSource :alphaSource ; :baseUrl "https://example.org/directory/" .
:thingSchema a :TargetSchema ; :targetClass schema:Thing .
:id a :TargetField ; :targetPredicate schema:identifier .
:name a :TargetField ; :targetPredicate schema:name ; sh:datatype xsd:string ; sh:minCount 1 .
:alphaSource a :Source ; :format ft:JSON ; :hasField :sourceId, :sourceName .
:sourceId a :SourceField ; :fieldPath "id" ; :iriSource true .
:sourceName a :SourceField ; :fieldPath "name" .
:mapping a :Mapping ; :fromSource :alphaSource ; :toTarget :thingSchema ;
    :hasFieldMapping [ :from :sourceId ; :to :id ], [ :from :sourceName ; :to :name ] .
:match a :MatchRule ; :forTarget :thingSchema ; :targetNamespace "urn:validation:" ; :mintedSubjectPrefix "thing-" .
`
const artifact = (root, file) => fs.readFileSync(path.join(root, file), "utf8")

test("the pipeline validates against the combined vocabulary and writes a conforming report", async (t) => {
    const root = makeInstance("valid-target", { federation: pipelineConfig, sources: { alpha: [{ id: "a1", name: "Advice" }] } })
    const logs = []
    t.mock.method(console, "log", (...args) => logs.push(args.join(" ")))
    await new Pipeline({ root }).run()
    const generated = await buildTargetVocabulary(pipelineConfig)
    assert.equal(artifact(root, PATHS.targetVocabulary), generated)
    const report = new Store(parseTtl(artifact(root, PATHS.validationReport)))
    assert.equal(report.getObjects(null, SH + "conforms", null)[0].value, "true")
    assert.ok(logs.some((line) => line.includes("directory.ttl conforms")))
    assert.match(artifact(root, PATHS.federateLog), /:validateStep a :Validate/)
    const graph = loadPipeline([artifact(root, PATHS.federateLog)], pipelineConfig)
    assert.equal(graph.edges.find((edge) => edge.to === "end").from, CDP + "validateStep")
    assert.match(graph.edges.find((edge) => edge.to === "end").value, /validation-report\.ttl/)
    assert.doesNotMatch(graph.edges.find((edge) => edge.to === "end").value, /shapes\.ttl/)
})

test("a combined vocabulary without SHACL annotations imposes no value constraints", async () => {
    const unconstrained = `${PREFIXES}
        :thing a :TargetSchema ; :targetClass schema:Thing ; :hasTargetField :name .
        :name a :TargetField ; :targetPredicate schema:name .
        schema:name rdfs:comment "An optional name."@en .`
    const validator = buildValidator(await buildTargetVocabulary(unconstrained))
    const data = `${PREFIXES} :missing a schema:Thing . :mixed a schema:Thing ; schema:name 42, "Advice" .`
    assert.equal((await validator.validate({ dataset: turtleToDataset(data) })).conforms, true)
})

test("the pipeline rejects invalid output and prints the SHACL report before publication", async (t) => {
    const root = makeInstance("invalid-target", { federation: pipelineConfig, sources: { alpha: [{ id: "a1", name: 42 }] } })
    // A publish failure would be a different error; validation must stop first.
    fs.writeFileSync(path.join(root, PATHS.publication), "")
    const errors = []
    t.mock.method(console, "error", (...args) => errors.push(args.join(" ")))
    await assert.rejects(new Pipeline({ root }).run(), /directory\.ttl failed SHACL validation/)
    const report = new Store(parseTtl(artifact(root, PATHS.validationReport)))
    assert.equal(report.getObjects(null, SH + "conforms", null)[0].value, "false")
    assert.equal(report.getObjects(null, SH + "resultPath", null)[0].value, SCHEMA + "name")
    assert.equal(report.getObjects(null, SH + "sourceConstraintComponent", null)[0].value, SH + "DatatypeConstraintComponent")
    for (const term of ["sh:focusNode", "sh:resultPath", "sh:sourceConstraintComponent"])
        assert.ok(errors.join("\n").includes(term), `console report includes ${term}`)
    assert.equal(fs.existsSync(path.join(root, PATHS.catalog)), false)
})
