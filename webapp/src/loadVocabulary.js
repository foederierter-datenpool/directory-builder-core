import { buildTargetVocabulary } from "../../src/target-vocabulary.js"
import { PATHS } from "@directory-builder/core/utils"

// Prefer the exact artifact used by the pipeline. Older snapshots can still
// display and download the profile generated from their matching config.
export async function loadVocabulary(federationTtl, readText) {
    return await readText(PATHS.targetVocabulary) || buildTargetVocabulary(federationTtl)
}
