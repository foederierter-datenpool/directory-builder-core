import { parseTtl, PATHS } from "@directory-builder/core/utils"
import { Pipeline, validate } from "@directory-builder/core"
import { makeInstance } from "./helpers/instance.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"
import fs from "fs"

// The ultra-minimal instance: federation.ttl + two static JSON sources,
// nothing else — fetch, clean and resolve all run on engine defaults. The
// sources share one record by name ("Entry One"), so the pipeline should
// merge a1+b1 and leave a2 and b2 as their own entities.

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

const root = makeInstance("tiny", { federation, sources: { alpha, beta } })

const expectedFinal = `@prefix schema: <http://schema.org/>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix dct: <http://purl.org/dc/terms/>.
@prefix cdf: <urn:test:>.

cdf:thing-5a45645edb31 a schema:Thing;
    schema:name "Entry Two".
cdf:thing-616feb993283 a schema:Thing;
    schema:name "Entry One".
cdf:thing-d1583c098826 a schema:Thing;
    schema:name "Entry Three".
`

test("the tiny fixture validates and runs the whole pipeline on defaults", async () => {
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
