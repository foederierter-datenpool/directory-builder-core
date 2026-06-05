// Node entry of @directory-builder/core. Browser-safe helpers live in the
// "./utils" subpath export — import those from "@directory-builder/core/utils"
// so bundlers never see the engines' fs/child_process imports.
export { Pipeline } from "./pipeline.js"
export { ingest } from "./pipeline/ingest.js"
export { federate } from "./pipeline/federate.js"
