import { buildValidator, turtleToDataset } from "@foerderfunke/sem-ops-utils"
import { writeTargetVocabulary } from "../../write-target-vocabulary.js"
import { PATHS } from "../../utils.js"
import { writeTurtleFile } from "../write-turtle.js"
import fs from "node:fs"

// Validate the completed output, after enrichment and before publication.
// Preflight config validation must not reject an older directory snapshot.
export async function runValidateDirectory({ abs }) {
    const vocabulary = await writeTargetVocabulary(abs("."))
    const validator = buildValidator(vocabulary)
    const report = await validator.validate({ dataset: turtleToDataset(fs.readFileSync(abs(PATHS.final), "utf8")) })
    await writeTurtleFile(abs(PATHS.validationReport), [...report.dataset], {
        sh: "http://www.w3.org/ns/shacl#", xsd: "http://www.w3.org/2001/XMLSchema#",
    })
    console.log(`validate: ${PATHS.final} ${report.conforms ? "conforms" : "FAILED"} (${report.results.length} result(s)) → ${PATHS.validationReport}`)
    if (!report.conforms) {
        console.error(fs.readFileSync(abs(PATHS.validationReport), "utf8"))
        throw new Error(`${PATHS.final} failed SHACL validation: ${report.results.length} result(s); see ${PATHS.validationReport}`)
    }
    return report
}
