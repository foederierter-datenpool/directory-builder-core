import { Pipeline } from "@directory-builder/core"
import { PATHS, parseTtl } from "@directory-builder/core/utils"
import { makeInstance } from "./helpers/instance.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"
import fs from "fs"

// A blocking key partitions the comparison space without deciding anything.
// These run the whole pipeline, because what matters is which pairs the match
// step ever gets to compare — not something a unit test of the bucketing shows.
//
// Two source fields map onto the same target predicate, which is how a record
// gets several blocking values without a JSON array (arrays lift to rdf:_N
// sequences the default extract doesn't flatten).

const federationWith = (matchRule) => `
@prefix :       <https://civic-data.de/pipeline#> .
@prefix schema: <http://schema.org/> .
@prefix ft:     <http://publications.europa.eu/resource/authority/file-type/> .

:federation a :Federation ;
    :hasSource :alphaSource, :betaSource .

:thingSchema a :TargetSchema ;
    :targetClass schema:Thing .

:t-id    a :TargetField ; :targetPredicate schema:identifier .
:t-name  a :TargetField ; :targetPredicate schema:name .
:t-block a :TargetField ; :targetPredicate schema:keywords ; :multiValued true .

:alphaSource a :Source ; :format ft:JSON ; :hasField :alpha-id, :alpha-name, :alpha-b1, :alpha-b2 .
:betaSource  a :Source ; :format ft:JSON ; :hasField :beta-id, :beta-name, :beta-b1, :beta-b2 .

:alpha-id   a :SourceField ; :fieldPath "id" ; :iriSource true .
:alpha-name a :SourceField ; :fieldPath "name" .
:alpha-b1   a :SourceField ; :fieldPath "b1" .
:alpha-b2   a :SourceField ; :fieldPath "b2" .
:beta-id    a :SourceField ; :fieldPath "id" ; :iriSource true .
:beta-name  a :SourceField ; :fieldPath "name" .
:beta-b1    a :SourceField ; :fieldPath "b1" .
:beta-b2    a :SourceField ; :fieldPath "b2" .

:alpha-mapping a :Mapping ; :fromSource :alphaSource ; :toTarget :thingSchema ;
    :hasFieldMapping [ :from :alpha-id ; :to :t-id ] , [ :from :alpha-name ; :to :t-name ] ,
                     [ :from :alpha-b1 ; :to :t-block ] , [ :from :alpha-b2 ; :to :t-block ] .

:beta-mapping a :Mapping ; :fromSource :betaSource ; :toTarget :thingSchema ;
    :hasFieldMapping [ :from :beta-id ; :to :t-id ] , [ :from :beta-name ; :to :t-name ] ,
                     [ :from :beta-b1 ; :to :t-block ] , [ :from :beta-b2 ; :to :t-block ] .

${matchRule}
`

const RULE = (extra) => `
:match a :MatchRule ;
    :forTarget           :thingSchema ;
    :targetNamespace     "urn:test:" ;
    :mintedSubjectPrefix "thing-" ;
    :minScore             1.0 ;
    :hasWeightedCriterion [ :on schema:name ; :weight 1.0 ] ${extra} .
`

const BLOCKED = `; :hasBlockingKey [ :on schema:keywords ]`

// Filler keeps every mapped :fieldPath present in each source's extracted
// output, which the drift check requires file-wide. Its name matches nothing.
const filler = (tag) => ({ id: `${tag}-filler`, name: `Filler ${tag}`, b1: `${tag}-f1`, b2: `${tag}-f2` })

// Entities that merged: registry clusters with more than one member.
const mergedPairs = (root) => {
    const members = new Map()
    for (const q of parseTtl(fs.readFileSync(path.join(root, PATHS.registry), "utf8"))) {
        if (!q.predicate.value.endsWith("hasMember")) continue
        if (!members.has(q.subject.value)) members.set(q.subject.value, [])
        members.get(q.subject.value).push(q.object.value)
    }
    return [...members.values()].filter(m => m.length > 1)
}

const run = async (name, matchRule, a, b) => {
    const root = makeInstance(name, {
        federation: federationWith(matchRule),
        sources: { alpha: [a, filler("a")], beta: [b, filler("b")] },
    })
    await new Pipeline({ root }).run()
    return root
}

test("a shared blocking value leaves the match untouched", async () => {
    const root = await run("blocking-shared", RULE(BLOCKED),
        { id: "a1", name: "Entry One", b1: "shared", b2: "a-only" },
        { id: "b1", name: "Entry One", b1: "shared", b2: "b-only" })
    assert.equal(mergedPairs(root).length, 1, "same bucket, compared as if unblocked")
})

test("a blocking key that separates a true pair prevents the comparison", async () => {
    // The recall cost, made explicit: identical names scoring 1.0, but no shared
    // bucket means the pair is never scored at all. This is why a blocking key
    // is a decision rather than a free optimisation.
    const root = await run("blocking-separated", RULE(BLOCKED),
        { id: "a1", name: "Entry One", b1: "alpha", b2: "alpha2" },
        { id: "b1", name: "Entry One", b1: "beta", b2: "beta2" })
    assert.equal(mergedPairs(root).length, 0, "never compared, so never matched despite a perfect score")
})

test("the same pair matches once the blocking key is removed", async () => {
    // Control for the test above — the only difference is the declaration.
    const root = await run("blocking-control", RULE(""),
        { id: "a1", name: "Entry One", b1: "alpha", b2: "alpha2" },
        { id: "b1", name: "Entry One", b1: "beta", b2: "beta2" })
    assert.equal(mergedPairs(root).length, 1)
})

test("a record with no blocking value is compared against everything", async () => {
    // Blocking narrows the question, it never answers it: a record the key
    // cannot place must not become unmatchable the way a missing hard value
    // does. Getting this backwards would silently drop records.
    const root = await run("blocking-unblocked", RULE(BLOCKED),
        { id: "a1", name: "Entry One" },                       // no b1/b2 on this record
        { id: "b1", name: "Entry One", b1: "beta", b2: "beta2" })
    assert.equal(mergedPairs(root).length, 1, "matched despite sharing no bucket")
})

test("one shared value out of several is enough", async () => {
    // Multi-valued is the point: a record sits in one bucket per value and a
    // pair meeting in any bucket is compared, so more values means more recall —
    // the opposite of a multi-valued hard criterion, which compares one
    // arbitrary member.
    const root = await run("blocking-multivalued", RULE(BLOCKED),
        { id: "a1", name: "Entry One", b1: "alpha-only", b2: "shared" },
        { id: "b1", name: "Entry One", b1: "shared", b2: "beta-only" })
    assert.equal(mergedPairs(root).length, 1, "meeting on the second value is enough")
})

test("a pair meeting in several buckets is recorded once", async () => {
    // Blocking puts a record in several buckets, so the same pair comes up more
    // than once; comparing it twice would duplicate its evidence in the log.
    const root = await run("blocking-dedup", RULE(BLOCKED),
        { id: "a1", name: "Entry One", b1: "x", b2: "y" },
        { id: "b1", name: "Entry One", b1: "x", b2: "y" })
    assert.equal(mergedPairs(root).length, 1)
    const evidence = parseTtl(fs.readFileSync(path.join(root, PATHS.matches), "utf8"))
        .filter(q => q.predicate.value.endsWith("aggregateScore"))
    assert.equal(evidence.length, 1, "two shared values, one evidence node")
})
