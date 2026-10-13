import assert from "node:assert/strict"
import { test } from "node:test"
import { matchPages, sliceMatch } from "../webapp/src/loadMatch.js"
import { readMatchData } from "@directory-builder/core/match-view"
import { CDP, NAMESPACES, parseTtl } from "../src/utils.js"

test("Match pages keep related clusters together and lay out the visible graph", () => {
    const nodes = [
        { id: "org", type: "org", isCluster: true },
        { id: "unrelated-1", type: "org", isCluster: true },
        { id: "unrelated-2", type: "org", isCluster: true },
        { id: "service", type: "service", isCluster: true },
        { id: "address", type: "address", isCluster: true },
        { id: "source", type: "orgSrc" },
    ]
    const edges = [
        { from: "org", to: "service", rel: true },
        { from: "service", to: "address", rel: true },
        { from: "source", to: "org" },
    ]
    const pages = matchPages(nodes, edges, 3)
    assert.deepEqual(pages, [["org", "service", "address"], ["unrelated-1", "unrelated-2"]])

    const result = { nodes, edges, members: new Map([["org", ["source"]]]),
        lanes: [{ key: "org" }, { key: "service" }, { key: "address" }] }
    const slice = sliceMatch(result, new Set(pages[0]))
    assert.deepEqual(slice.nodes.map((node) => node.id), ["org", "service", "address", "source"])
    assert.equal(slice.edges.length, 3)
    assert.ok(slice.nodes.every((node) => Number.isFinite(slice.nodeY.get(node.id))))
})

test("Match page layout terminates for cyclic relationships", () => {
    const nodes = ["a", "b"].map(id => ({ id, type: "org", isCluster: true }))
    const result = sliceMatch({ nodes, members: new Map(), lanes: [{ key: "org" }],
        edges: [{ from: "a", to: "b", rel: true }, { from: "b", to: "a", rel: true }],
    }, new Set(["a", "b"]))
    assert.ok(nodes.every(node => Number.isFinite(result.nodeY.get(node.id))))
})

test("Match labels and member order do not depend on graph storage order", () => {
    const config = `@prefix : <${CDP}> . :federation :hasTargetSchema :orgSchema .
        :orgSchema :targetClass <${NAMESPACES.schema}Organization> .`
    const matches = parseTtl(`@prefix : <${CDP}> . <urn:cluster> a :MatchCluster ; :hasMember <urn:b>, <urn:a> .`)
    const merged = parseTtl(`@prefix schema: <${NAMESPACES.schema}> .
        <urn:cluster> a schema:Organization ; schema:name "Advice", "Advice centre", "Centre advice" .`)
    const first = readMatchData(config, matches, merged)
    const reversed = readMatchData(config, [...matches].reverse(), [...merged].reverse())
    assert.deepEqual(first.nodes, reversed.nodes)
    assert.deepEqual(first.members, reversed.members)
    assert.equal(first.nodes[0].label, "Advice centre")
})
