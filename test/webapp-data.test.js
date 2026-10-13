import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { DataFactory as df, Store } from "n3"
import { CDP, NAMESPACES, parseTtl, PATHS, prefixesOf } from "../src/utils.js"
import { createChunkLoader, decodeDirectoryIndex, decodeEntityChunk, decodeMatchChunk, decodeMatchIndex, decodeMergeIndex, directoryComparator } from "@directory-builder/core/webapp-data"
import { createResolutionLookup, groupMergeEntities, mergeViewSettings, summarizeMergeEntity } from "@directory-builder/core/merge-view"
import { buildMatchGraph, loadMatch, matchPages, readSchemas, sliceMatch } from "@directory-builder/core/match-view"
import { writeWebappData } from "../src/pipeline/webapp-data.js"
import { writeTurtleFile } from "../src/pipeline/write-turtle.js"
import { MAPPED_GRAPH } from "../src/pipeline/steps/map.js"
import { MATCH_GRAPH, HAS_MEMBER } from "../src/pipeline/steps/match.js"
import { runMerge } from "../src/pipeline/steps/merge.js"
import { runResolve } from "../src/pipeline/steps/resolve.js"
import { loadMerge } from "../webapp/src/loadMerge.js"

const config = `
@prefix : <${CDP}> .
@prefix schema: <${NAMESPACES.schema}> .
@prefix rdf: <${NAMESPACES.rdf}> .
:federation :hasSource :alphaSource, :betaSource ; :webappChunking true .
:federation :hasTargetSchema :org, :address, :service .
:org :targetClass schema:Organization .
:address :targetClass schema:PostalAddress .
:service :targetClass schema:Service .
:category :targetPredicate schema:category ; :multiValued true .
:provider :targetPredicate schema:provider .
:addressField :targetPredicate schema:address .
[] :toTargetField :provider ; :toTargetSchema :org .
[] :toTargetField :addressField ; :toTargetSchema :address .
:match a :MatchRule ; :targetNamespace "urn:entity:" .
:serviceMatch :forTarget :service ; :hasHardCriterion [ :on schema:provider ] .
:mapping :toTarget :service ; :hasRelationship [ :toTargetSchema :org ; :toTargetField :provider ] .
`
const curation = `@prefix : <${CDP}> . @prefix schema: <${NAMESPACES.schema}> .
[] a :ValueCorrection ; :entity <urn:record:a-0> ; :on schema:name ; :wrong "Wrong" ; :right "Right" .
[] a :ValueCorrection ; :on schema:name ; :wrong "Wrong" ; :right "Right" .`

test("Browser chunks preserve resolved cards, Match graphs and complete artifacts", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-data-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const abs = file => path.join(root, file)
    fs.mkdirSync(abs("config"))
    fs.writeFileSync(abs(PATHS.federation), config)
    fs.writeFileSync(abs(PATHS.curation), curation)
    const store = new Store(), defStore = new Store(parseTtl(config + curation))
    const addRecord = (name, cluster, source, type, fields) => {
        const subject = df.namedNode(`urn:record:${name}`)
        store.addQuad(df.quad(df.namedNode(`urn:entity:${cluster}`), df.namedNode(`${NAMESPACES.rdf}type`), df.namedNode(`${CDP}MatchCluster`), MATCH_GRAPH))
        store.addQuad(df.quad(df.namedNode(`urn:entity:${cluster}`), HAS_MEMBER, subject, MATCH_GRAPH))
        store.addQuad(df.quad(subject, df.namedNode(`${NAMESPACES.rdf}type`), df.namedNode(`${NAMESPACES.schema}${type}`), MAPPED_GRAPH))
        store.addQuad(df.quad(subject, df.namedNode(`${CDP}fromSource`), df.namedNode(`${CDP}${source}Source`), MAPPED_GRAPH))
        for (const [predicate, value] of fields) store.addQuad(df.quad(subject,
            df.namedNode(`${NAMESPACES.schema}${predicate}`), typeof value === "string" ? df.literal(value) : value, MAPPED_GRAPH))
    }
    for (let i = 0; i < 201; i++) addRecord(`a-${i}`, `org-${i}`, "alpha", "Organization",
        [["identifier", `a-${i}`], ["name", i ? `Organisation ${i}` : "Wrong"]])
    addRecord("b-0", "org-0", "beta", "Organization", [["identifier", "b-0"], ["name", "Right"]])
    addRecord("a-copy", "org-0", "alpha", "Organization", [["name", "Wrong"]])
    addRecord("address", "address", "alpha", "PostalAddress", [["streetAddress", "Example Street"]])
    addRecord("service", "service", "alpha", "Service", [["provider", df.namedNode("urn:record:a-100")]])
    const extra = (record, predicate, value) => store.addQuad(df.quad(df.namedNode(`urn:record:${record}`),
        df.namedNode(`${NAMESPACES.schema}${predicate}`), value, MAPPED_GRAPH))
    extra("a-0", "category", df.literal("Advice"))
    extra("b-0", "category", df.literal("Care"))
    extra("a-0", "address", df.namedNode("urn:record:address"))
    for (const text of ["schema:provider", "<urn:outside>", "https://example.org/", "<p>Grüße &amp; Hilfe</p>"])
        extra("a-0", "description", df.literal(text))
    extra("a-0", "seeAlso", df.namedNode("urn:outside"))

    const ctx = { store, defStore, abs, quads: parseTtl(config) }
    await writeTurtleFile(abs(PATHS.mapped), store.getQuads(null, null, null, MAPPED_GRAPH))
    await writeTurtleFile(abs(PATHS.matches), store.getQuads(null, null, null, MATCH_GRAPH))
    await runMerge(ctx, PATHS.merged, PATHS.provenance, PATHS.entitySources)
    await runResolve(ctx, PATHS.final)
    const artifacts = [PATHS.mapped, PATHS.matches, PATHS.merged, PATHS.provenance, PATHS.entitySources, PATHS.final]
    const original = artifacts.map(file => fs.readFileSync(abs(file)))
    writeWebappData(ctx)
    artifacts.forEach((file, position) => assert.deepEqual(fs.readFileSync(abs(file)), original[position], file))

    const settings = mergeViewSettings(ctx.quads)
    const expected = loadMerge(fs.readFileSync(abs(PATHS.merged), "utf8"), fs.readFileSync(abs(PATHS.provenance), "utf8"), config)
        .sort((a, b) => summarizeMergeEntity(b, settings).conflictCount - summarizeMergeEntity(a, settings).conflictCount
            || a.iri.localeCompare(b.iri))
    const index = JSON.parse(fs.readFileSync(abs(PATHS.webappIndex), "utf8"))
    const decoded = decodeMergeIndex(index)
    assert.deepEqual(decoded.map(({ chunk, ...entity }) => entity), expected.map(entity => summarizeMergeEntity(entity, settings)))
    assert.deepEqual(decoded.find(entity => entity.iri === "urn:entity:org-0").parents, [], "addresses are not hierarchy parents")
    assert.deepEqual(decoded.find(entity => entity.iri === "urn:entity:service").parents, ["urn:entity:org-100"])
    assert.equal(new Set(groupMergeEntities(decoded).slice(0, 100).map(row => row.e.chunk)).size, 1)

    const resolutionOf = createResolutionLookup(ctx.quads, store.getQuads(null, null, null, MATCH_GRAPH), parseTtl(curation),
        parseTtl(fs.readFileSync(abs(PATHS.final), "utf8")), { cdp: CDP, ...prefixesOf(config) })
    assert.equal(fs.statSync(abs(PATHS.webappData)).mode & 0o777, 0o755)
    const load = createChunkLoader(chunk => decodeEntityChunk(JSON.parse(fs.readFileSync(abs(PATHS.mergeChunk(chunk)), "utf8")), index))
    const details = await load(decoded)
    for (const entity of details) for (const field of entity.fields) if (field.resolution)
        assert.deepEqual(field.resolution, resolutionOf(entity.iri, field))
    assert.deepEqual(details.map(entity => ({ ...entity, fields: entity.fields.map(({ resolution, ...field }) => field) })), expected)
    const chunks = fs.readdirSync(abs(PATHS.webappData)).filter(file => file.startsWith("merge-"))
    const chunkBytes = chunks.reduce((total, file) => total + fs.statSync(abs(`${PATHS.webappData}/${file}`)).size, 0)
    assert.ok(chunkBytes < Buffer.byteLength(JSON.stringify(details)) / 2, "chunks avoid repeated display values and record lists")
    const directory = decodeDirectoryIndex(index)
    const finalCards = loadMerge(fs.readFileSync(abs(PATHS.final), "utf8"), "", config)
        .sort(directoryComparator(ctx.quads, { cdp: CDP, ...prefixesOf(config) }))
    assert.equal(directory[0].type, "schema:Organization")
    assert.equal(new Set(directory.slice(0, 100).map(entity => entity.chunk)).size, 1)
    const loadFinal = createChunkLoader(chunk => decodeEntityChunk(JSON.parse(fs.readFileSync(abs(PATHS.directoryChunk(chunk)), "utf8")), index))
    assert.deepEqual(await loadFinal(directory), finalCards)
    assert.deepEqual(directory.map(entity => entity.sources), directory.map(entity => decoded.find(merged => merged.iri === entity.iri).sources))

    const matchIndex = JSON.parse(fs.readFileSync(abs(PATHS.matchIndex), "utf8"))
    const metadata = decodeMatchIndex(matchIndex)
    const match = loadMatch(config, fs.readFileSync(abs(PATHS.matches), "utf8"), fs.readFileSync(abs(PATHS.merged), "utf8"), { layoutLimit: 0 })
    assert.deepEqual(metadata.nodes.map(node => node.id), match.nodes.map(node => node.id))
    assert.deepEqual(metadata.edges, match.edges)
    const loadClusters = createChunkLoader(chunk => decodeMatchChunk(JSON.parse(fs.readFileSync(abs(PATHS.matchChunk(chunk)), "utf8")), matchIndex))
    const clusters = await loadClusters(metadata.nodes)
    assert.deepEqual(clusters.map(cluster => cluster.label), match.nodes.map(node => node.label))
    assert.deepEqual(clusters.find(cluster => cluster.iri === "urn:entity:service").records[0].values, ["Organisation 100"], "relationship criteria display the target's name")
    const firstPage = new Set(matchPages(metadata.nodes, metadata.edges, 80)[0])
    const detailsForPage = clusters.filter(cluster => firstPage.has(cluster.iri))
    const chunkGraph = buildMatchGraph({ lanes: readSchemas(config).lanes,
        nodes: detailsForPage.map(cluster => ({ id: cluster.iri, type: cluster.type, label: cluster.label, isCluster: true })),
        edges: metadata.edges, members: new Map(detailsForPage.map(cluster => [cluster.iri, cluster.records.map(record => record.iri)])),
    }, { showDuplications: true })
    const rdfGraph = sliceMatch(loadMatch(config, fs.readFileSync(abs(PATHS.matches), "utf8"), fs.readFileSync(abs(PATHS.merged), "utf8"), { showDuplications: true, layoutLimit: 0 }), firstPage)
    assert.deepEqual(chunkGraph.nodes, rdfGraph.nodes)
    assert.deepEqual(chunkGraph.edges, rdfGraph.edges)
    assert.deepEqual(chunkGraph.nodeY, rdfGraph.nodeY)

    t.mock.method(fs, "writeFileSync", () => { throw new Error("disk full") })
    assert.throws(() => writeWebappData(ctx), /disk full/)
    assert.ok(fs.existsSync(abs(PATHS.webappIndex)))
    assert.ok(fs.readdirSync(abs("data")).every(name => !name.startsWith(".webapp-")))
    t.mock.restoreAll()
    for (const flag of ["false", null]) {
        fs.mkdirSync(abs(PATHS.webappData), { recursive: true })
        writeWebappData({ ...ctx, quads: parseTtl(flag ? config.replace("true", flag) : config.replace("; :webappChunking true", "")) })
        assert.equal(fs.existsSync(abs(PATHS.webappData)), false)
        artifacts.forEach((file, position) => assert.deepEqual(fs.readFileSync(abs(file)), original[position], file))
    }
})

test("Directory follows schema references rather than schema definitions or IRI order", () => {
    const entities = [
        { iri: "urn:0", type: "schema:Unknown" },
        { iri: "urn:address", type: "schema:PostalAddress" },
        { iri: "urn:org-z", type: "schema:Organization" },
        { iri: "urn:service", type: "schema:Service" },
        { iri: "urn:org-a", type: "schema:Organization" },
    ]
    const prefixes = prefixesOf(config)
    const ordered = config.replace(":org, :address, :service", ":service, :org, :address")
    assert.deepEqual(entities.toSorted(directoryComparator(parseTtl(ordered), prefixes)).map(e => e.iri),
        ["urn:service", "urn:org-a", "urn:org-z", "urn:address", "urn:0"])
    assert.deepEqual(entities.toSorted(directoryComparator([], prefixes)).map(e => e.iri),
        ["urn:0", "urn:address", "urn:org-a", "urn:org-z", "urn:service"])
})

test("Page loading fetches only required chunks, shares requests and retries failures", async () => {
    const requests = []
    const load = createChunkLoader(async chunk => {
        requests.push(chunk)
        if (chunk === 2 && requests.filter(n => n === 2).length === 1) throw new Error("temporary failure")
        return [{ iri: `urn:${chunk}` }]
    })
    const rows = [{ iri: "urn:1", chunk: 1 }, { iri: "urn:0", chunk: 0 }]
    const [first, second] = await Promise.all([load(rows), load(rows)])
    assert.deepEqual(first, [{ iri: "urn:1" }, { iri: "urn:0" }])
    assert.deepEqual(second, first)
    await load(rows.slice(0, 1))
    assert.deepEqual(requests, [1, 0])
    await assert.rejects(load([{ iri: "urn:2", chunk: 2 }]), /temporary failure/)
    assert.deepEqual(await load([{ iri: "urn:2", chunk: 2 }]), [{ iri: "urn:2" }])
    assert.deepEqual(requests, [1, 0, 2, 2])
})

test("Merge grouping preserves filtered children and terminates on cycles", () => {
    const parent = { iri: "urn:parent", parents: [] }
    const child = { iri: "urn:child", parents: [parent.iri] }
    assert.deepEqual(groupMergeEntities([child, parent]), [{ e: parent, depth: 0 }, { e: child, depth: 1 }])
    assert.deepEqual(groupMergeEntities([child]), [{ e: child, depth: 0 }])
    const a = { iri: "urn:a", parents: ["urn:b"] }, b = { iri: "urn:b", parents: ["urn:a"] }
    assert.deepEqual(groupMergeEntities([a, b]), [{ e: a, depth: 0 }, { e: b, depth: 1 }])
})
