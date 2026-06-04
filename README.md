# directory-builder-core

Use-case-agnostic engine for config-driven federation pipelines: fetch
heterogeneous sources, lift them to RDF, clean, map them onto a unified target
schema, then match, merge and resolve them into one federated directory.

An **instance** is a repo holding only declarative config and per-source
artefacts — no engine code:

```
config/
  federation.ttl        # the decisions: sources + facts, target schemas,
                        # field mappings, match/merge/resolve rules
  match-knowledge.ttl   # curated owl:sameAs pairs
sources/<name>/
  fetch.js              # how to fetch this source
  clean.sparql          # how to clean its lifted RDF
  static/               # the data itself, for static-file sources
```

Everything else follows by convention from the source names. See
[`example/`](example/) for a runnable instance and the full data flow.

## Prerequisites

- Node.js
- Java (for [SPARQL Anything](https://github.com/SPARQL-Anything/sparql.anything),
  auto-downloaded on first run)

## Run a pipeline

Two ways — both run the same engines, rooted at the instance directory.

Via command (root = where you invoke):

```sh
npm install @directory-builder/core
npx directory-builder            # full pipeline: ingest + federate
npx directory-builder ingest     # fetch + lift only
npx directory-builder federate   # clean → map → match → merge → resolve only
```

Or programmatically:

```js
import { Pipeline } from "@directory-builder/core"

const pipeline = new Pipeline()   // root defaults to process.cwd()
await pipeline.run()              // ingest + federate
```

`new Pipeline({ root })` points the engines at an instance directory other
than the cwd — e.g. for driving several instances from one process or a test
fixture.

Engines journal their executed steps as p-plan RDF (`data/ingest/ingest-log.ttl`,
`data/pipeline/federate-log.ttl`) — evidence of what ran, not a plan.

## Run the webapp

The webapp ships with the package; it fetches an instance's `config/` +
`data/` at runtime, so one app serves every use case and instances hold no
webapp code. From an instance directory:

```sh
npx directory-builder webapp                         # dev server
npx directory-builder webapp build --base /repo/     # production build → dist/
```

For webapp development in this repo:

```sh
npm run webapp                                       # dev server on example/
INSTANCE=../sosuse-directory-builder npm run webapp  # any other instance dir
```

Instances can inject **exporters** — output adapters mapping the directory
into an external schema. The federation declares them (`:federation
:hasExporter "x"`), the module lives at `exporters/x.js` in the instance
(served and deployed like config and data), and the Download page loads it at
runtime: it exports `label` / `filename` / `mime` and
`build(finalTtl, toolkit)`, where the toolkit passes in helpers like
`sparqlSelect`, since a runtime-loaded module cannot resolve bare imports.

Browser-safe helpers (TTL parsing, path conventions, journal vocabulary) are
exported separately so bundlers never see the engines' Node imports:

```js
import { CDP, parseTtl, PATHS } from "@directory-builder/core/utils"
```
