import { buildTargetVocabulary } from "./target-vocabulary.js"
import { PATHS } from "./utils.js"
import fs from "node:fs"
import path from "node:path"

export async function writeTargetVocabulary(root = process.cwd()) {
    const vocabulary = await buildTargetVocabulary(fs.readFileSync(path.join(root, PATHS.federation), "utf8"))
    const output = path.join(root, PATHS.targetVocabulary)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, vocabulary)
    console.log(`vocabulary: wrote ${PATHS.targetVocabulary}`)
    return vocabulary
}
