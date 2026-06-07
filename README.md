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
  match-knowledge.ttl   # optional: curated owl:sameAs pairs
sources/<name>/
  fetch.js              # how to fetch this source
  clean.sparql          # how to clean its lifted RDF
  static/               # the data itself, for static-file sources
registry/
  identity.ttl          # engine-maintained: minted entity IRIs and their
                        # source members — accumulated state, commit it
webapp/
  content/about.md      # optional: the webapp's About page prose
  exporters/<name>.js   # optional: output adapters the webapp loads at runtime
```

The `webapp/` half is entirely optional — a pipeline-only instance is just
`config/` + `sources/`, producing `data/` for downstream use.

Everything else follows by convention from the source names. The discovery
rule: a named open set (sources, exporters) is declared in federation.ttl and
its files follow by convention; a single well-known slot (the About page)
works by file presence alone. See [`example/`](example/) for a runnable
instance and the full data flow.

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

Each source's `fetch.js` is invoked as `node fetch.js <outDir> <fetchUrl-or-staticDir>
<runParamsJson>` — the JSON holds all `:hasRunParam` values grouped by name;
each fetcher picks the parameters it needs. For static-file sources `fetch.js`
is optional: without one, the default fetch copies `sources/<name>/static/`
verbatim. `clean.sparql` is likewise optional when the source maps a field to
`schema:identifier`: the engine derives a default clean from that mapping —
skolemise on the identifier field, copy the scalar fields — and puts the
resolved query on record under `data/pipeline/default-clean-queries/`.

A source declared with `:enabled false` stays in the config but is skipped by
the engines and hidden from the webapp's Sources page — e.g. while its files
aren't available yet.

Engines journal their executed steps as p-plan RDF (`data/ingest/ingest-log.ttl`,
`data/pipeline/federate-log.ttl`) — evidence of what ran, not a plan.

Minting is write-once: the match step keeps an identity registry
(`registry/identity.ttl`, created on the first run) assigning each source
record to its minted entity IRI. A cluster with a known member reuses the
registered IRI, so identities survive re-harvests however membership evolves;
only unseen entities mint fresh. Unlike `data/`, the registry is accumulated
state, not derived output — commit it, and review its diff after each harvest.

## Run the webapp

The webapp ships with the package; it fetches an instance's `config/` +
`data/` at runtime, so one app serves every use case and instances hold no
webapp code. From an instance directory:

```sh
npx directory-builder webapp                         # dev server
npx directory-builder webapp build --base /repo/     # production build → webapp/dist/
```

`webapp build` stages the instance's `config/`, `data/` and
`webapp/{content,exporters}/` into `webapp/dist/` next to the bundle —
`webapp/dist/` is the complete site, ready to publish as-is.

The two are independent: the dev server never needs a prior build — `webapp
build` exists only to produce the deployable. Both show whatever `data/` the
pipeline last produced, so run the pipeline first (and rebuild before
publishing, or `dist/` keeps the stale snapshot).

For webapp development in this repo:

```sh
npm run webapp                                       # dev server on example/
INSTANCE=../sosuse-directory-builder npm run webapp  # any other instance dir
```

Instances own the About page by providing `webapp/content/about.md` (markdown,
served and deployed like config and data); without one, a generic default
renders — and the Query page's starting query the same way, via
`webapp/content/query.sparql`. On the `:federation` node, `rdfs:label` sets
the page title and `:repository "https://github.com/…"` adds the GitHub links
(nav, static-source folders); both stay generic/hidden when absent.

Instances can inject **exporters** — output adapters mapping the directory
into an external schema. The federation declares them (`:federation
:hasExporter "x"`), the module lives at `webapp/exporters/x.js` in the instance
(served and deployed like config and data), and the Download page loads it at
runtime: it exports `label` / `filename` / `mime` and
`build(finalTtl, toolkit)`, where the toolkit passes in helpers like
`sparqlSelect`, since a runtime-loaded module cannot resolve bare imports.

Browser-safe helpers (TTL parsing, path conventions, journal vocabulary) are
exported separately so bundlers never see the engines' Node imports:

```js
import { CDP, parseTtl, PATHS } from "@directory-builder/core/utils"
```

## Roadmap

- Testing
- Periodic harvesting
- `@directory-builder/create`: an npm initializer scaffolding a new use
  case, plus a `validate` command checking an instance setup
- `@directory-builder/ui`: extract the webapp into its own package
- ...
