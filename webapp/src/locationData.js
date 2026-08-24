// The shared location list decides whether this instance has a Map view and
// supplies that view when opened. Module evaluation caches the result, so the
// finished directory is parsed only once for both uses.

import { federationTtl, finalTtl } from "./instanceData.js"
import { loadLocations } from "./loadLocations.js"

export const locations = loadLocations(finalTtl, federationTtl)
export const hasLocations = locations.length > 0
