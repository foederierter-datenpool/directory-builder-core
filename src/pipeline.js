import { ingest } from "./ingest.js"
import { federate } from "./federate.js"

// Programmatic entry: hold the instance root once, run the engines against it.
// The CLI (bin/cli.js) is this same class with defaults — root = cwd.
export class Pipeline {
    constructor({ root = process.cwd() } = {}) {
        this.root = root
    }
    ingest()   { return ingest(this.root) }
    federate() { return federate(this.root) }
    async run() {
        await this.ingest()
        await this.federate()
    }
}
