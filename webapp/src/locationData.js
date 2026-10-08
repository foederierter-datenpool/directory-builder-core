// Load map locations when the Map view opens. Module evaluation caches the
// parsed result while that view remains loaded.

import { federationTtl, fetchText } from "./instanceData.js"
import { loadLocations, turtleEntry } from "./loadLocations.js"
import { PATHS } from "@directory-builder/core/utils"

const finalTtl = await fetchText(PATHS.final)
export const locations = loadLocations(finalTtl, federationTtl)
export const turtleForIri = (iri) => turtleEntry(finalTtl, iri)
