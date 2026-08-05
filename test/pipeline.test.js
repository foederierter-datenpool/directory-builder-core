import { CDP, parseTtl, PATHS } from "@directory-builder/core/utils"
import { Pipeline, validate } from "@directory-builder/core"
import { scaffoldPublication } from "../src/publication.js"
import { makeInstance } from "./helpers/instance.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"
import fs from "fs"

// ---- Shared fixture: the ultra-minimal instance both tests run on ----------
// federation.ttl + two static JSON sources, nothing else — fetch, extract and
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

:alphaSource a :Source ; :format ft:JSON ; :hasField :alpha-id, :alpha-name .
:betaSource  a :Source ; :format ft:JSON ; :hasField :beta-id, :beta-label .

:alpha-id   a :SourceField ; :fieldPath "id" ; :iriSource true .
:alpha-name a :SourceField ; :fieldPath "name" .
:beta-id    a :SourceField ; :fieldPath "id" ; :iriSource true .
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
    // registry and history stay byte-identical (a no-change harvest, extract diff).
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

// ---- Test 3: the post-extract drift check ------------------------------------
// A mapping reads a field the source data doesn't carry: shape-valid config, but
// extract produces no xyz:ghost, so map would silently drop it. federate catches
// the drift after extract, before map.

test("federate rejects when a mapped field never reaches the extracted output", async () => {
    const drifted = `
@prefix :       <https://civic-data.de/pipeline#> .
@prefix schema: <http://schema.org/> .
@prefix ft:     <http://publications.europa.eu/resource/authority/file-type/> .

:federation a :Federation ; :hasSource :alphaSource .
:thingSchema a :TargetSchema ; :targetClass schema:Thing .
:t-id   a :TargetField ; :targetPredicate schema:identifier .
:t-name a :TargetField ; :targetPredicate schema:name .

:alphaSource a :Source ; :format ft:JSON ; :hasField :alpha-id, :alpha-ghost .
:alpha-id    a :SourceField ; :fieldPath "id"    ; :iriSource true .
:alpha-ghost a :SourceField ; :fieldPath "ghost" .   # never present in the data below

:alpha-mapping a :Mapping ; :fromSource :alphaSource ; :toTarget :thingSchema ;
    :hasFieldMapping [ :from :alpha-id ; :to :t-id ] , [ :from :alpha-ghost ; :to :t-name ] .

:match a :MatchRule ; :forTarget :thingSchema ; :targetNamespace "urn:test:" ; :mintedSubjectPrefix "thing-" .
`
    const root = makeInstance("drift", { federation: drifted, sources: { alpha: [{ id: "a1" }] } })
    // config is shape-valid (the field is declared) — the drift only shows post-extract
    assert.deepEqual(await validate(root), [])
    await assert.rejects(new Pipeline({ root }).run(), /drifted from config[\s\S]*:alpha-ghost[\s\S]*"ghost"/)
})

// ---- Test 4: curated value corrections --------------------------------------
// beta misspells b1 as "Entry Ohne" — a typo that sorts before "Entry One", so
// alphabeticFirst would pick it. curation.ttl forces the merge
// (owl:sameAs; the typo also breaks the fuzzy match) and pins the correction to
// the source record carrying the typo (:beta-b1, translated to its minted
// cluster at resolve): the wrong literal is rewritten, the conflict collapses,
// and final.ttl comes out byte-identical to the clean fixture's.

test("a curated :ValueCorrection rewrites a known-wrong literal at resolve", async () => {
    const curation = `
@prefix :       <https://civic-data.de/pipeline#> .
@prefix owl:    <http://www.w3.org/2002/07/owl#> .
@prefix schema: <http://schema.org/> .

:alpha-a1 owl:sameAs :beta-b1 .
[] a :ValueCorrection ; :entity :beta-b1 ;
    :on schema:name ; :wrong "Entry Ohne" ; :right "Entry One" .
`
    const root = makeInstance("correction", { federation, curation,
        sources: { alpha, beta: [{ id: "b1", label: "Entry Ohne" }, beta[1]] } })
    await new Pipeline({ root }).run()
    assert.equal(fs.readFileSync(path.join(root, PATHS.final), "utf8"), expectedFinal)
})

// ---- Test 5: the default longestValue strategy ------------------------------
// Two sources merge on an identical name but carry different-length descriptions.
// With no :ResolveRule configured the engine defaults to longestValue, so the
// fuller description survives — alphabeticFirst would have picked "Beratung"
// ("B" sorts before "Z"), proving the default is length- not alphabet-driven.

test("the default longestValue strategy keeps the fullest conflicting value", async () => {
    const withDesc = `
@prefix :       <https://civic-data.de/pipeline#> .
@prefix schema: <http://schema.org/> .
@prefix ft:     <http://publications.europa.eu/resource/authority/file-type/> .

:federation a :Federation ; :hasSource :alphaSource, :betaSource .
:thingSchema a :TargetSchema ; :targetClass schema:Thing .
:t-id   a :TargetField ; :targetPredicate schema:identifier .
:t-name a :TargetField ; :targetPredicate schema:name .
:t-desc a :TargetField ; :targetPredicate schema:description .

:alphaSource a :Source ; :format ft:JSON ; :hasField :alpha-id, :alpha-name, :alpha-desc .
:betaSource  a :Source ; :format ft:JSON ; :hasField :beta-id, :beta-name, :beta-desc .
:alpha-id   a :SourceField ; :fieldPath "id" ; :iriSource true .
:alpha-name a :SourceField ; :fieldPath "name" .
:alpha-desc a :SourceField ; :fieldPath "desc" .
:beta-id    a :SourceField ; :fieldPath "id" ; :iriSource true .
:beta-name  a :SourceField ; :fieldPath "name" .
:beta-desc  a :SourceField ; :fieldPath "desc" .

:alpha-mapping a :Mapping ; :fromSource :alphaSource ; :toTarget :thingSchema ;
    :hasFieldMapping [ :from :alpha-id ; :to :t-id ] , [ :from :alpha-name ; :to :t-name ] , [ :from :alpha-desc ; :to :t-desc ] .
:beta-mapping a :Mapping ; :fromSource :betaSource ; :toTarget :thingSchema ;
    :hasFieldMapping [ :from :beta-id ; :to :t-id ] , [ :from :beta-name ; :to :t-name ] , [ :from :beta-desc ; :to :t-desc ] .

:match a :MatchRule ; :forTarget :thingSchema ; :targetNamespace "urn:test:" ;
    :mintedSubjectPrefix "thing-" ; :minScore 1.0 ;
    :hasWeightedCriterion [ :on schema:name ; :weight 1.0 ] .
`
    const root = makeInstance("longest", { federation: withDesc, sources: {
        alpha: [{ id: "a1", name: "Shared", desc: "Beratung" }],
        beta:  [{ id: "b1", name: "Shared", desc: "Zentrum für umfassende Sozialberatung" }],
    } })
    assert.deepEqual(await validate(root), [])
    await new Pipeline({ root }).run()
    const final = parseTtl(fs.readFileSync(path.join(root, PATHS.final), "utf8"))
    // a1+b1 merged on their identical name; the longer description wins the conflict
    const descs = final.filter((q) => q.predicate.value === "http://schema.org/description").map((q) => q.object.value)
    assert.deepEqual(descs, ["Zentrum für umfassende Sozialberatung"])
})

// ---- Test: the opt-in publish step -------------------------------------------
// publication.ttl turns the publish step on; the catalog it writes must satisfy
// the DCAT-AP.de constraints in publish.shacl.ttl, which validate() checks.
// Publishing needs a deployment URL, declared once for the whole instance —
// every published IRI below is built on this :baseUrl.
const publishedFederation = federation.replace(
    ":hasSource :alphaSource, :betaSource .",
    ':hasSource :alphaSource, :betaSource ; :baseUrl "https://example.org/d/" .')

const publication = `
@prefix :       <https://civic-data.de/pipeline#> .
@prefix dcat:   <http://www.w3.org/ns/dcat#> .
@prefix dct:    <http://purl.org/dc/terms/> .
@prefix dcatde: <http://dcat-ap.de/def/dcatde/> .
@prefix foaf:   <http://xmlns.com/foaf/0.1/> .

:federation a dcat:Catalog ;
    dct:title "Testkatalog"@de ; dct:description "Testbeschreibung"@de ; dct:publisher :publisher .
:publisher a foaf:Agent ; foaf:name "Test e.V." .
:thingSchema :publishedAs :thingDataset .
:thingDataset a dcat:Dataset ;
    dct:title "Dinge"@de ; dct:description "Testdaten"@de ; dct:publisher :publisher .
:distributionDefaults a :DistributionTemplate ;
    dct:license <http://dcat-ap.de/def/licenses/dl-by-de/2.0> ;
    dcatde:licenseAttributionByText "Test e.V." .
`

test("publish writes a catalog conforming to the DCAT-AP.de shape", async () => {
    const root = makeInstance("publish", { federation: publishedFederation, sources: { alpha, beta }, publication })
    await new Pipeline({ root }).run()
    assert.deepEqual(await validate(root), [])
    const catalog = parseTtl(fs.readFileSync(path.join(root, PATHS.catalog), "utf8"))
    const dist = `https://example.org/d/${PATHS.final}`
    assert.ok(catalog.some((q) => q.predicate.value === "http://www.w3.org/ns/dcat#distribution"
        && q.object.value === dist), "the dataset carries the derived Turtle distribution")
    assert.ok(catalog.some((q) => q.subject.value === dist
        && q.predicate.value === "http://dcat-ap.de/def/dcatde/licenseAttributionByText"),
        "the distribution template is stamped onto it")
    // The config's subjects live in the shared pipeline namespace, so they are
    // renamed onto :baseUrl — one instance's catalog must be identifiable.
    assert.deepEqual(
        catalog.filter((q) => q.predicate.value === "http://www.w3.org/ns/dcat#dataset").map((q) => q.object.value),
        ["https://example.org/d/#thingDataset"])
    assert.ok(catalog.some((q) => q.subject.value === "https://example.org/d/#catalog"
        && q.object.value === "http://www.w3.org/ns/dcat#Catalog"), "the catalog is published under :baseUrl")
    assert.ok(!catalog.some((q) => q.subject.value.startsWith(CDP) || q.object.value.startsWith(CDP)),
        "no pipeline-namespace term (:publishedAs and its :TargetSchema) reaches the published catalog")
    // The browser-built formats have no URL, so the Download page is the only
    // way a harvested dataset can offer anything but Turtle.
    assert.deepEqual(
        catalog.filter((q) => q.predicate.value === "http://www.w3.org/ns/dcat#landingPage").map((q) => q.object.value),
        ["https://example.org/d/#/download"])
    assert.deepEqual(
        catalog.filter((q) => q.predicate.value === "http://dcat-ap.de/def/dcatde/qualityProcessURI").map((q) => q.object.value),
        ["https://example.org/d/#/pipeline"])
    // The dataset's :TargetSchema :targetClass, the one triple saying what is inside.
    assert.deepEqual(
        catalog.filter((q) => q.predicate.value === "http://purl.org/dc/terms/conformsTo").map((q) => q.object.value),
        ["http://schema.org/Thing"])
    // Origins per dataset, from the :Mapping declarations: both sources map
    // into the one target schema here, in :hasSource declaration order.
    assert.deepEqual(
        catalog.filter((q) => q.predicate.value === "http://www.w3.org/2000/01/rdf-schema#label").map((q) => q.object.value),
        ["Merged from alpha, beta by this directory's pipeline."])
})

// ---- Test: the publication.ttl draft ---------------------------------------
// `directory-builder init publication` writes a first draft from federation.ttl.
// Its contract is that it is valid on arrival: the publish step runs on it
// unedited and validate stays clean, so an author fills in decisions rather than
// debugging shapes. The placeholders must be visible in the published catalog,
// not hidden in comments, so an unfinished draft cannot ship unnoticed.

test("init publication drafts a valid publication.ttl from federation.ttl", async () => {
    const root = makeInstance("draft", { federation: publishedFederation, sources: { alpha, beta } })
    const draft = scaffoldPublication(root)
    assert.equal(draft.datasets, 1, "one dcat:Dataset per target schema")
    const ttl = fs.readFileSync(path.join(root, PATHS.publication), "utf8")
    assert.match(ttl, /:thingSchema :publishedAs :thingDataset \./)
    assert.match(ttl, /foaf:homepage\s+<https:\/\/example\.org\/d\/>/, ":baseUrl becomes the catalog's homepage")

    await new Pipeline({ root }).run()
    assert.deepEqual(await validate(root), [], "the unedited draft publishes a valid catalog")
    const catalog = parseTtl(fs.readFileSync(path.join(root, PATHS.catalog), "utf8"))
    assert.ok(catalog.some((q) => q.object.value.startsWith("TODO:")), "placeholders reach the catalog")
    // The draft is hand-edited from here on — config/ holds no regenerated files.
    assert.throws(() => scaffoldPublication(root), /refusing to overwrite/)
})

test("validate rejects a catalog missing the attribution an attribution license needs", async () => {
    const root = makeInstance("publish-bad", { federation: publishedFederation, sources: { alpha, beta },
        publication: publication.replace(/ ;\n    dcatde:licenseAttributionByText "Test e.V."/, "") })
    await new Pipeline({ root }).run()
    const problems = await validate(root)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /licenseAttributionByText/)
})
