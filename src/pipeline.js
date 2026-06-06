import { ingest } from "./pipeline/ingest.js"
import { federate } from "./pipeline/federate.js"
import { validate } from "./validate.js"

// Programmatic entry: hold the instance root once, run the engines against it.
// The CLI (bin/cli.js) is this same class with defaults — root = cwd.
export class Pipeline {
    constructor({ root = process.cwd() } = {}) {
        this.root = root
    }
    async validate() {
        const problems = await validate(this.root)
        if (problems.length) throw new Error(`invalid instance at ${this.root}:\n  ${problems.join("\n  ")}`)
    }
    async ingest()   { await this.validate(); return ingest(this.root) }
    async federate() { await this.validate(); return federate(this.root) }
    async run() {
        await this.ingest()
        await this.federate()
    }
}
