// Loads the complete RDF snapshot for Merge views without chunks.
import { parseTtl, PATHS } from "@directory-builder/core/utils"
import { federationTtl, fetchTexts, displayPrefixes } from "./instanceData.js"
import { createResolutionLookup } from "@directory-builder/core/merge-view"

const [curationTtl, matchesTtl, finalTtl] = await fetchTexts([PATHS.curation, PATHS.matches, PATHS.final])
export const resolutionOf = createResolutionLookup(
    parseTtl(federationTtl), parseTtl(matchesTtl), parseTtl(curationTtl), parseTtl(finalTtl), displayPrefixes)
