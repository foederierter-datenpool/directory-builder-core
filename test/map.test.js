import { strict as assert } from "node:assert"
import { test } from "node:test"
import { loadLocations } from "../webapp/src/loadLocations.js"

test("map groups entities under their geocoded address", () => {
    const federation = `
        @prefix : <https://civic-data.de/pipeline#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        @prefix schema: <http://schema.org/> .
        :places a :TargetSchema ; :targetClass schema:Organization ; rdfs:label "Place" .
        :addresses a :TargetSchema ; :targetClass schema:PostalAddress ; rdfs:label "Address" .
        :address a :TargetField ; :targetPredicate schema:address .
        :mapping a :Mapping ; :hasRelationship [ :toTargetField :address ; :toTargetSchema :addresses ] .`
    const final = `
        @prefix : <https://example.com/> .
        @prefix schema: <http://schema.org/> .
        :address a schema:PostalAddress ; schema:streetAddress "Main Street 1" ; schema:postalCode "10115" ;
            schema:addressLocality "Berlin" ; schema:latitude "52.5" ; schema:longitude "13.4" .
        :orphan a schema:PostalAddress ; schema:latitude "52.6" ; schema:longitude "13.5" .
        :place a schema:Organization ; schema:name "Example Place" ; schema:address :address .`

    assert.deepEqual(loadLocations(final, federation), [{
        iri: "https://example.com/address", latitude: 52.5, longitude: 13.4,
        lines: ["Main Street 1", "10115 Berlin"], label: "Main Street 1, 10115 Berlin",
        entities: [{ iri: "https://example.com/place", label: "Example Place", type: "Place",
            turtle: ':place a schema:Organization ; schema:name "Example Place" ; schema:address :address .' }],
    }])
})
