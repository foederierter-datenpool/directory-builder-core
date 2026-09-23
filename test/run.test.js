import { run } from "../src/pipeline/run.js"
import assert from "node:assert/strict"
import { test } from "node:test"

// Output is captured and prefixed rather than inherited, because sources now
// run concurrently and interleaved mid-line output is unattributable.
const sink = () => {
    const chunks = []
    return { write: (c) => { chunks.push(String(c)); return true }, text: () => chunks.join("") }
}

// One sink for both streams, so interleaving is visible the way it is on a terminal.
const capture = async (fn) => {
    const s = sink()
    await fn(s)
    return s.text()
}

const node = (src, opts = {}) => (s) => run("node", ["-e", src], { ...opts, out: s, err: s })

test("every line is prefixed with the label", async () => {
    const out = await capture(node(`console.log("one"); console.log("two")`, { label: "alpha" }))
    assert.equal(out, "[alpha] one\n[alpha] two\n")
})

test("a line split across chunks is not split across sources", async () => {
    // The failure this prevents: a chunk boundary mid-line emitting half a line
    // under one label and the rest under another.
    const out = await capture(node(
        `process.stdout.write("partial "); setTimeout(() => process.stdout.write("completed\\n"), 20)`,
        { label: "alpha" }))
    assert.equal(out, "[alpha] partial completed\n")
})

test("output with no trailing newline is still emitted", async () => {
    const out = await capture(node(`process.stdout.write("dangling")`, { label: "alpha" }))
    assert.equal(out, "[alpha] dangling\n")
})

test("a carriage-return redraw becomes one line each", async () => {
    // Documented cost of attributable output: a progress counter that redraws
    // in place cannot stay in place once it is prefixed.
    const out = await capture(node(`process.stdout.write("1/3\\r2/3\\r3/3\\r")`, { label: "alpha" }))
    assert.equal(out, "[alpha] 1/3\n[alpha] 2/3\n[alpha] 3/3\n")
})

test("stderr is labelled too", async () => {
    const out = await capture(node(`console.error("boom")`, { label: "alpha" }))
    assert.equal(out, "[alpha] boom\n")
})

test("no label means no prefix", async () => {
    assert.equal(await capture(node(`console.log("bare")`)), "bare\n")
})

test("a non-zero exit rejects with the command in the message", async () => {
    await assert.rejects(() => node(`process.exit(3)`, { label: "alpha" })(sink()), /Exit 3: node -e/)
})

test("a command that cannot start rejects rather than hanging", async () => {
    await assert.rejects(() => run("definitely-not-a-real-binary-xyz", [], { label: "alpha", out: sink(), err: sink() }))
})

test("concurrent children keep their lines attributable", async () => {
    // The point of the change: two children interleaving must still be readable.
    const out = await capture((s) => Promise.all([
        node(`for (let i=0;i<5;i++) console.log("a"+i)`, { label: "alpha" })(s),
        node(`for (let i=0;i<5;i++) console.log("b"+i)`, { label: "beta" })(s),
    ]))
    const lines = out.trim().split("\n")
    assert.equal(lines.length, 10)
    assert.ok(lines.every(l => /^\[(alpha|beta)\] [ab]\d$/.test(l)), `every line attributable:\n${out}`)
    assert.equal(lines.filter(l => l.startsWith("[alpha]")).length, 5)
})
