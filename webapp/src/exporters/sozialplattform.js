// Exporter: maps the federated directory into Sozialplattform's JSON shape via a
// SPARQL query. A bespoke output adapter (target-specific by nature).
// Reads:  a TTL string passed by Download.jsx (final.ttl)
// Does:   returns an array of Sozialplattform offer objects

import { sparqlSelect } from "@foerderfunke/sem-ops-utils/sparql"
import { storeFromTurtles } from "@foerderfunke/sem-ops-utils/core"
import { localName } from "@directory-builder/core/utils"

const QUERY = `
PREFIX schema: <http://schema.org/>
PREFIX dct:    <http://purl.org/dc/terms/>

SELECT ?org
       (SAMPLE(?n)   AS ?name)
       (SAMPLE(?s)   AS ?street)
       (SAMPLE(?pc)  AS ?postalCode)
       (SAMPLE(?l)   AS ?locality)
       (SAMPLE(?co)  AS ?country)
       (SAMPLE(?cat) AS ?category)
       (SAMPLE(?ph)  AS ?phone)
       (SAMPLE(?em)  AS ?email)
WHERE {
    ?org schema:name ?n .
    OPTIONAL { ?org schema:streetAddress   ?s   }
    OPTIONAL { ?org schema:postalCode      ?pc  }
    OPTIONAL { ?org schema:addressLocality ?l   }
    OPTIONAL { ?org schema:addressCountry  ?co  }
    OPTIONAL { ?org dct:subject            ?cat }
    OPTIONAL { ?org schema:telephone       ?ph  }
    OPTIONAL { ?org schema:email           ?em  }
}
GROUP BY ?org
ORDER BY ?org`

export async function toSozialplattformJson(mergedTtl) {
    const rows = await sparqlSelect(QUERY, [storeFromTurtles([mergedTtl])])
    return rows.map((r) => ({
        offer_id:                              localName(r.org),
        offer_nid:                             "",
        offer_title:                           "",
        offer_service_area:                    "",
        search_score:                          null,
        offer_external_service_type:           "",
        offer_external_id_booking:             "",
        offer_external_service_booking:        "",
        offer_external_service_consulting:     "",
        offer_external_service_link_url:       "",
        offer_external_service_link_text:      "",
        office_address_short:                  [r.country, r.locality, r.postalCode, r.street].filter(Boolean).join(", "),
        office_address: {
            langcode:                          null,
            country_code:                      r.country    ?? null,
            locality:                          r.locality   ?? null,
            postal_code:                       r.postalCode ?? null,
            address_line1:                     r.street     ?? null,
            address_line3:                     null,
        },
        office_title:                          r.name  ?? "",
        office_phone:                          r.phone ?? "",
        office_email:                          r.email ?? "",
        office_opening_hours:                  "",
        office_opening_hours_notes:            "",
        office_external_service_type:          "",
        office_external_id_booking:            "",
        office_external_service_booking:       "",
        office_external_id_consulting:         "",
        office_external_service_consulting:    "",
        offer_type:                            r.category ?? "",
        offer_chat_topic:                      "",
    }))
}
