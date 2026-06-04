# Example use case

A minimal, self-contained example use case that exercises the whole pipeline with two
**static file sources** — fictional library directories (`cityopen`, `civichub`)
with **deliberately different schemas** that partly overlap, so the field
mappings, then Match/Merge/Resolve, all have visible work to do.

It doubles as the engine's smoke test and as the dataset a scaffolded use case can start from.

## Layout

```
example/
  config/
    federation.ttl        # the decisions: sources + facts, one schema:Organization
                          # target, field mappings, match/merge/resolve rules
    match-knowledge.ttl   # curated owl:sameAs pairs (empty here)
  sources/
    cityopen/  { fetch.js, clean.sparql, static/libraries.json }
    civichub/  { fetch.js, clean.sparql, static/libraries.json }
```

That's everything a use case is: config + one folder per source. Each source
folder is self-contained — how to fetch it, how to clean it, and (for static
sources) the data itself.

## Run it

```shell
npm install
npm run example
```

To browse the result, `npm run webapp` serves the webapp against this example.

Or programmatically:

```js
import { Pipeline } from "../src/pipeline.js"   // from the package: @directory-builder/core

await new Pipeline({ root: "example/" }).run()  // root defaults to process.cwd()
```

A downstream use-case repo does the same with the published package: depend on
`@directory-builder/core` and call `npx directory-builder` — no engine code in
the use case.

Outputs land in `data/` (git-ignored, regenerable):

```
data/ingest/raw/<source>/        raw JSON copied in by fetch.js
data/ingest/lifted/<source>/     RDF after the generic JSON lift
data/ingest/ingest-log.ttl       journaled fetch/lift steps + harvest times
data/pipeline/cleaned/<source>.ttl
data/pipeline/mapped.ttl         schema: vocabulary, both sources
data/pipeline/matches.ttl        cross-source match evidence
data/pipeline/merged.ttl         clustered, minted cluster IRIs
data/pipeline/provenance.ttl     which source said what
data/pipeline/final.ttl          one resolved record per organisation
data/pipeline/federate-log.ttl   journaled clean→…→resolve steps
```

The two `*-log.ttl` files are the engines' p-plan step journals — written as a
side effect of execution, they are what the webapp's Pipeline page renders.
