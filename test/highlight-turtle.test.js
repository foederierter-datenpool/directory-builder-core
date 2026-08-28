import assert from "node:assert/strict"
import test from "node:test"

test("Turtle highlighting works without a global Prism", async () => {
    delete globalThis.Prism
    const { highlightTurtle } = await import("../webapp/src/highlightTurtle.js")

    const highlighted = highlightTurtle(`@prefix schema: <http://schema.org/> .\n:place schema:name "Example" .`)

    assert.match(highlighted, /token keyword/)
    assert.match(highlighted, /token url/)
    assert.match(highlighted, /token string/)
})
