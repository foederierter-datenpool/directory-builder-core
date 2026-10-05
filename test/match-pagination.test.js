import assert from "node:assert/strict"
import { test } from "node:test"
import { matchPages, sliceMatch } from "../webapp/src/loadMatch.js"

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
