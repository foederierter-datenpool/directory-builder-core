import { CDP, parseTtl, PATHS } from "@directory-builder/core/utils"
import { Pipeline, validate } from "@directory-builder/core"
import { makeInstance } from "./helpers/instance.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"
import fs from "fs"

// ---- Shared fixture: the ultra-minimal instance both tests run on ----------
// federation.ttl + two static JSON sources, nothing else — fetch, clean and
// resolve all run on engine defaults. The sources share one record by name
// ("Entry One"), so the pipeline should merge a1+b1 and leave a2 and b2 as
// their own entities.

const federation = `
@prefix :       <https://civic-data.de/pipeline#> .
@prefix schema: <http://schema.org/> .
@prefix ft:     <http://publications.europa.eu/resource/authority/file-type/> .

:federation a :Federation ;
    :hasSource :alphaSource, :betaSource .

:thingSchema a :TargetSchema ;
    :targetClass schema:Thing .

:t-id   a :TargetField ; :targetPredicate schema:identifier .
:t-name a :TargetField ; :targetPredicate schema:name .

:alphaSource a :Source ; :format ft:JSON .
:betaSource  a :Source ; :format ft:JSON .

:alpha-id   a :SourceField ; :fieldPath "id" .
:alpha-name a :SourceField ; :fieldPath "name" .
:beta-id    a :SourceField ; :fieldPath "id" .
:beta-label a :SourceField ; :fieldPath "label" .

:alpha-mapping a :Mapping ; :fromSource :alphaSource ; :toTarget :thingSchema ;
    :hasFieldMapping [ :from :alpha-id ; :to :t-id ] , [ :from :alpha-name ; :to :t-name ] .

:beta-mapping a :Mapping ; :fromSource :betaSource ; :toTarget :thingSchema ;
    :hasFieldMapping [ :from :beta-id ; :to :t-id ] , [ :from :beta-label ; :to :t-name ] .

:match a :MatchRule ;
    :forTarget           :thingSchema ;
    :targetNamespace     "urn:test:" ;
    :mintedSubjectPrefix "thing-" ;
    :minScore             1.0 ;
    :hasWeightedCriterion [ :on schema:name ; :weight 1.0 ] .
`

const alpha = [
    { id: "a1", name: "Entry One" },
    { id: "a2", name: "Entry Two" },
]
const beta = [
    { id: "b1", label: "Entry One" },
    { id: "b2", label: "Entry Three" },
]

// The consumer-facing artifact the shared fixture resolves to (both tests).
const expectedFinal = `@prefix schema: <http://schema.org/>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix dct: <http://purl.org/dc/terms/>.
@prefix cdf: <urn:test:>.

cdf:thing-5a45645edb31 a schema:Thing;
    schema:name "Entry Two".
cdf:thing-d1583c098826 a schema:Thing;
    schema:name "Entry Three".
cdf:thing-e427416d02ac a schema:Thing;
    schema:name "Entry One".
`

// ---- Test 1: the whole pipeline on defaults --------------------------------

test("the tiny fixture validates and runs the whole pipeline on defaults", async () => {
    const root = makeInstance("tiny", { federation, sources: { alpha, beta } })
    // the fixture satisfies the instance contract (folders, derivable defaults, shape)
    assert.deepEqual(await validate(root), [])
    await new Pipeline({ root }).run()
    const finalTtl = fs.readFileSync(path.join(root, PATHS.final), "utf8")
    const final = parseTtl(finalTtl)
    // match merged a1+b1 on their identical name; a2 and b2 stay their own entities
    const subjects = new Set(final.map((q) => q.subject.value))
    assert.equal(subjects.size, 3, "a1+b1 merge, a2 and b2 stay alone")
    // entity IRIs are minted from the match rule's :targetNamespace + :mintedSubjectPrefix
    for (const s of subjects) assert.match(s, /^urn:test:thing-/)
    // map carried both sources' name fields through, resolve kept one value per entity
    const names = final.filter((q) => q.predicate.value === "http://schema.org/name").map((q) => q.object.value)
    assert.deepEqual(names.toSorted(), ["Entry One", "Entry Three", "Entry Two"])
    // and the consumer-facing artifact as a whole
    assert.equal(finalTtl, expectedFinal)
})

// ---- Test 2: periodic harvesting & the identity registry -------------------

// The identity registry the first harvest writes: each minted IRI's source
// members, the write-once record later runs reconcile against.
const expectedRegistry = `@prefix cdp: <https://civic-data.de/pipeline#>.
@prefix cdf: <urn:test:>.

cdf:thing-5a45645edb31 cdp:hasMember cdp:alpha-a2.
cdf:thing-d1583c098826 cdp:hasMember cdp:beta-b2.
cdf:thing-e427416d02ac cdp:hasMember cdp:alpha-a1, cdp:beta-b1.
`

// history.ttl events as {type, entity, member[], revision}: each event is a
// nested [entity ; members] binding hung off its :Revision node under a type
// predicate (cdp:minted / cdp:memberJoined). Timestamps vary per run, so the
// test asserts structure, not bytes.
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
const EVENT_PREDS = { minted: "Minted", memberJoined: "MemberJoined" }
const parseEvents = (ttl) => {
    const quads = parseTtl(ttl)
    const events = []
    for (const [local, type] of Object.entries(EVENT_PREDS)) {
        for (const q of quads.filter((x) => x.predicate.value === CDP + local)) {
            const node = q.object.value // the [entity ; members] binding's blank node
            events.push({
                type,
                entity: quads.find((x) => x.subject.value === node && x.predicate.value === CDP + "entity")?.object.value,
                member: quads.filter((x) => x.subject.value === node && x.predicate.value === CDP + "member")
                    .map((x) => x.object.value).toSorted(),
                revision: q.subject.value, // the :Revision node the binding hangs off
            })
        }
    }
    return events
}
const revisionNodes = (ttl) => parseTtl(ttl)
    .filter((q) => q.predicate.value === RDF_TYPE && q.object.value === CDP + "Revision")
    .map((q) => q.subject.value).toSorted()

test("harvest rounds keep minted IRIs stable (write-once identity registry)", async () => {
    const root = makeInstance("harvest", { federation, sources: { alpha, beta } })
    const pipeline = new Pipeline({ root })
    const writeSource = (name, records) =>
        fs.writeFileSync(path.join(root, PATHS.staticDir(name), "data.json"), JSON.stringify(records, null, 4))
    const artifact = (p) => fs.readFileSync(path.join(root, p), "utf8")
    const id = (local) => "urn:test:" + local
    const src = (local) => CDP + local

    // round 1 — the first harvest mints the three identities into the registry,
    // and opens the history with one Minted event apiece (the genesis record).
    await pipeline.run()
    assert.equal(artifact(PATHS.final), expectedFinal)
    assert.equal(artifact(PATHS.registry), expectedRegistry)
    const history1 = artifact(PATHS.registryHistory)
    assert.deepEqual(parseEvents(history1).toSorted((a, b) => a.entity.localeCompare(b.entity)), [
        { type: "Minted", entity: id("thing-5a45645edb31"), member: [src("alpha-a2")], revision: src("revision-1") },
        { type: "Minted", entity: id("thing-d1583c098826"), member: [src("beta-b2")], revision: src("revision-1") },
        { type: "Minted", entity: id("thing-e427416d02ac"), member: [src("alpha-a1"), src("beta-b1")], revision: src("revision-1") },
    ])
    assert.deepEqual(revisionNodes(history1), [src("revision-1")], "genesis opens revision 1")

    // round 2 — harmless upstream edit: b2 renames to "Entry Drei", membership
    // unchanged. The directory carries the new name under the same IRI, and both
    // registry and history stay byte-identical (a no-change harvest, clean diff).
    writeSource("beta", [beta[0], { id: "b2", label: "Entry Drei" }])
    await pipeline.run()
    const expectedRenamed = expectedFinal.replace(`"Entry Three"`, `"Entry Drei"`)
    assert.equal(artifact(PATHS.final), expectedRenamed)
    assert.equal(artifact(PATHS.registry), expectedRegistry)
    assert.equal(artifact(PATHS.registryHistory), history1, "no event appended for a no-op harvest")

    // round 3 — a new alpha record joins b2's cluster. alpha-a3 sorts before
    // beta-b2, so a stateless smallest-member seed would re-mint here — only the
    // registry lookup preserves the identity: the directory is unchanged, the
    // entity just gained its second member, and history records exactly that.
    writeSource("alpha", [...alpha, { id: "a3", name: "Entry Drei" }])
    await pipeline.run()
    assert.equal(artifact(PATHS.final), expectedRenamed)
    assert.equal(artifact(PATHS.registry),
        expectedRegistry.replace("cdp:beta-b2.", "cdp:beta-b2, cdp:alpha-a3."))
    assert.ok(artifact(PATHS.registryHistory).startsWith(history1), "history only appends, never rewrites")
    const inRev2 = parseEvents(artifact(PATHS.registryHistory)).filter((e) => e.revision === src("revision-2"))
    assert.deepEqual(inRev2, [
        { type: "MemberJoined", entity: id("thing-d1583c098826"), member: [src("alpha-a3")], revision: src("revision-2") },
    ])
    assert.deepEqual(revisionNodes(artifact(PATHS.registryHistory)), [src("revision-1"), src("revision-2")],
        "the changing harvest opens revision 2; the no-op round 2 added none")
})
