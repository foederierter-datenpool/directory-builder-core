import path from "path"
import fs from "fs"

// Static-file source: copy the committed JSON straight into the ingest area.
// A live source would instead call an API here and write the responses out.
// argv: [outDir, sourceDir, plzCsv]  — plzCsv is unused for this static example.
const OUT_DIR = process.argv[2]
const SRC_DIR = process.argv[3]

fs.mkdirSync(OUT_DIR, { recursive: true })
for (const f of fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".json"))) {
    fs.copyFileSync(path.join(SRC_DIR, f), path.join(OUT_DIR, f))
    console.log(`  ${f} → ${OUT_DIR}`)
}
