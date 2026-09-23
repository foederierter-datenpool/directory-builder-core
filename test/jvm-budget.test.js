import { jvmBudget } from "../src/pipeline/steps/lift.js"
import assert from "node:assert/strict"
import { test } from "node:test"

// Tracks how many jobs are in flight at once, which is the only property that
// matters: the budget exists to bound concurrent JVMs, each a separate process
// with its own heap.
const tracker = () => {
    let active = 0, peak = 0
    return {
        peak: () => peak,
        job: (ms = 5) => async () => {
            active++; peak = Math.max(peak, active)
            await new Promise((r) => setTimeout(r, ms))
            active--
            return "done"
        },
    }
}

test("the budget caps how many jobs run at once", async () => {
    const t = tracker()
    const budget = jvmBudget(3)
    const results = await Promise.all(Array.from({ length: 12 }, () => budget(t.job())))
    assert.equal(t.peak(), 3)
    assert.equal(results.length, 12)
    assert.ok(results.every((r) => r === "done"), "every job still ran")
})

test("one budget shared across sources bounds the total, not each source", async () => {
    // The design point: with sources concurrent *and* each source's files
    // concurrent, two per-scope limits multiply. A shared budget is what
    // actually bounds the machine.
    const t = tracker()
    const budget = jvmBudget(4)
    const source = () => Promise.all(Array.from({ length: 6 }, () => budget(t.job())))
    await Promise.all([source(), source(), source()])
    assert.equal(t.peak(), 4, "three sources of six files each still never exceed the shared budget")
})

test("a budget of one is sequential", async () => {
    const t = tracker()
    const budget = jvmBudget(1)
    await Promise.all(Array.from({ length: 5 }, () => budget(t.job())))
    assert.equal(t.peak(), 1)
})

test("a failing job frees its slot", async () => {
    // Otherwise one failure would permanently shrink the budget, and enough of
    // them would deadlock the run.
    const t = tracker()
    const budget = jvmBudget(2)
    const outcomes = await Promise.allSettled([
        budget(async () => { throw new Error("boom") }),
        budget(async () => { throw new Error("boom") }),
        budget(t.job()),
        budget(t.job()),
    ])
    assert.equal(outcomes.filter((o) => o.status === "rejected").length, 2)
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 2)
    assert.ok(t.peak() <= 2)
})

test("the rejection reaches the caller rather than being swallowed", async () => {
    await assert.rejects(() => jvmBudget(2)(async () => { throw new Error("lift failed") }), /lift failed/)
})
