# directory-builder-core

Use-case-agnostic engine for config-driven federation pipelines: fetch
heterogeneous sources, lift them to RDF, extract typed entities, map them onto a
unified target schema, then match, merge and resolve them into one federated
directory.

An **instance** is a repo holding only declarative config and per-source
artefacts — no engine code:

```
config/
  federation.ttl        # the decisions: sources + facts, target schemas,
                        # field mappings, match/merge/resolve rules
  curation.ttl          # optional: curated owl:sameAs pairs, value corrections
  publication.ttl       # optional: DCAT-AP.de catalog metadata; present turns
                        # the publish step on (→ data/catalog.ttl).
                        # `init publication` drafts one from federation.ttl
sources/<name>/
  fetch.js              # how to fetch this source
  extract.sparql        # how to extract entities from its lifted RDF
  static/               # the data itself, for static-file sources
registry/
  identity.ttl          # engine-maintained: minted entity IRIs and their
                        # source members — accumulated state, commit it
  history.ttl           # engine-maintained: append-only log of identity
                        # events (mint, member joined)
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

## Installation

1. Create a new directory, e.g. `my-federation`
2. Inside it, run `npm install @directory-builder/core`
3. To start from a runnable example, run `npx directory-builder init` — copies
   the example's `config/` and `sources/` (from this repo's [`example/`](example/))
   into the current directory. Skip it to start empty.

### Configuring the pipeline

Edit `config/federation.ttl` — the federation's decisions (sources, target
schemas, field mappings, match/merge/resolve rules, and an opt-in `:EnrichRule`
to geocode entities or inherit values across an entity relationship). It's the
one required file; see [`example/config/federation.ttl`](example/config/federation.ttl) for
a worked example and [`src/validate/federation.shacl.ttl`](src/validate/federation.shacl.ttl)
for the full contract it must satisfy. Then, per source:

- create `sources/<name>/fetch.js` (optional — static sources default to copying `static/`)
- create `sources/<name>/extract.sparql` (optional when a field maps to `schema:identifier`)
- for static-file sources, put the data in `sources/<name>/static/`

Add `:federation :baseUrl "https://example.org/directory/"` for a directory that
gets deployed: it is the single statement of where the webapp lives, feeding both
the webapp build's base and the IRIs the publish step below writes.

Optionally add curated `owl:sameAs` / `owl:differentFrom` pairs and
`:ValueCorrection` entries (known-wrong literals, rewritten at resolve) in
`config/curation.ttl`.

To publish the directory as an open dataset, add `config/publication.ttl`. Start
from a draft derived from your federation:

```sh
npx directory-builder init publication
```

It writes the catalog node, its homepage from `:baseUrl`, and one `dcat:Dataset`
per target schema — titled from each schema's `rdfs:label` — leaving a `TODO:`
placeholder wherever only you can decide (publisher, contact, licence, prose).
The draft is valid as it stands, so the publish step works immediately and the
placeholders show up in the published catalog until you replace them; the licence
placeholder is `other-closed`, which grants nothing, so an unedited draft cannot
publish data under an open licence nobody chose. From there it is a hand-edited
config file like the others — nothing regenerates it, and it refuses to
overwrite.

The file holds [DCAT-AP.de 3.0](https://www.dcat-ap.de/def/dcatde/3.0/spec/)
catalog metadata (publisher, licence, themes); see
[`example/config/publication.ttl`](example/config/publication.ttl) for a filled-in
one. The catalog and the other nodes it describes are published under
`:federation :baseUrl`.

Check the setup before running: `npx directory-builder validate`.

## Run a pipeline

Two ways — both run the same engines, rooted at the instance directory.

Via command (root = where you invoke):

```sh
npx directory-builder            # full pipeline: ingest + federate
npx directory-builder ingest     # fetch + lift only
npx directory-builder federate   # extract → map → match → merge → resolve (→ enrich) only
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
verbatim. `extract.sparql` is likewise optional when the source flags one of its
fields `:iriSource true`: the engine derives a default extract from that field —
skolemise on it (URI-escaped, so any value mints a valid IRI), copy the scalar
fields — and puts the resolved query on record under
`data/pipeline/default-extract-queries/`. `:iriSource` names the mint key
directly, independent of whether that field is also mapped to
`schema:identifier` in the output.

A source declared with `:enabled false` stays in the config but is skipped by
the engines and hidden from the webapp's Sources page — e.g. while its files
aren't available yet.

Engines journal their executed steps as p-plan RDF (`data/ingest/ingest-log.ttl`,
`data/pipeline/federate-log.ttl`) — evidence of what ran, not a plan.

The federation pipeline also writes `data/pipeline/preparation/<source>.ttl`:
per-source Turtle files containing recorded before/after cleanup values and
normalised match keys. These complement `data/provenance.ttl`, which traces the
federated values' origins. The Entities info modal links to
`data/pipeline/preparation/` on the published site and, for GitHub repositories,
on the `gh-pages` branch. Their contents load only when a file is opened.

Minting is write-once: the match step keeps an identity registry
(`registry/identity.ttl`, created on the first run) assigning each source
record to its minted entity IRI. A cluster with a known member reuses the
registered IRI, so identities survive re-harvests however membership evolves;
only unseen entities mint fresh. Alongside it, `registry/history.ttl` is an
append-only log of identity events (mint, member joined) grouped under a
timestamped `:Revision` node per changing run — the registry's provenance,
where the snapshot in `identity.ttl` came from. Both are written only when
something changes, so a no-op harvest leaves them — and their git diff —
untouched, and the revision counter only advances when identity actually moves.
Unlike `data/`, the registry is accumulated state, not derived output — commit
it, and review its diff after each harvest.

## Run the webapp

The webapp ships with the package; it fetches an instance's `config/` +
`data/` at runtime, so one app serves every use case and instances hold no
webapp code. From an instance directory:

```sh
npx directory-builder webapp                         # dev server
npx directory-builder webapp build                    # production build → webapp/dist/
npx directory-builder webapp build --base /repo/     # ... with an explicit vite base
```

The build's base comes from `:federation :baseUrl`'s path when that is declared,
so a deployment states its URL once and the built site's asset paths cannot
drift from the IRIs the published catalog points at. `--base` overrides it (and
warns when the two disagree).

`webapp build` stages the instance's `config/`, `data/` and
`webapp/{content,exporters}/` into `webapp/dist/` next to the bundle —
`webapp/dist/` is the complete site, ready to publish as-is.

Vite generates a minimal HTML index in `data/` and each of its subdirectories,
with relative links to files, child directories and the parent. These indexes
also work in development, skip hidden files and preserve any existing
`index.html`. Pipeline → Pipeline files links to `data/` on the site and, for
GitHub repositories, on the `gh-pages` branch. Browsing an index loads no data
files until a link is opened.

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

The APIs page shows a short default guide to `directory-api`. Provide
`webapp/content/apis.md` to replace it with your instance's endpoints and examples.
The file is optional and is served/published with the other webapp content.

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

## Large datasets

Scale costs wall-clock, memory, and completeness. What to reach for, and what
each costs you.

**Fetch**
- `harvest({ partitions })` — split the query space when an API caps results per
  query. Caps are often undocumented and silent, so leave headroom.
- `emit` — sums each partition's reported total and fails the run on a
  shortfall. This is the check; the writing is incidental.
- `limit` — marks a deliberate development cap so that check is skipped.
- `project` — trim records before writing. Prefer a size cap exempting mapped
  fields; the bulk sits in different fields in different slices, so deny-lists
  rot.
- `:maxConcurrentSources` (default 3) — sources fetch and lift as concurrent
  per-source chains. A source's lift starts as soon as its own fetch finishes.

*Caveat:* a long harvest against a large-response endpoint can hit a Node
`undici` assertion raised on a socket callback — not a rejected promise, so
`retry` cannot see it and the process dies. Neither serialising nor
`connection: close` prevents it. Run each partition in a child process and
retry it; cache per partition so a crash costs one partition, not the run.

**Lift** — one JVM per raw file.
- `emit({ chunk })` — pack many documents per file to cut the JVM count.
- Chunked lifts are split back into one TTL per record automatically, and the
  lift selector is supplied from `emit`'s own wrapper. Keep `extract.sparql` in
  its unchunked form — anchoring patterns to a record and walking down from it
  is what made chunking quadratic before splitting existed.
- `:maxConcurrentLifts` (default 4) — a global JVM budget, not per source. The
  two limits compose, so this one bounds the machine.

**Extract** — memory-bound, one store per file, one source at a time.

*Caveat:* a source's extracted quads accumulate in memory until that source is
written. Streaming them is not available: dedup and sort need the whole output.
This is the ceiling on a very large source.

Extract is deliberately not parallelised. It is CPU-bound JavaScript, so
concurrency measured 1.14x, and worker threads measured 0.46x — slower, because
each worker has to re-import the query engine.

**Match** — all-pairs O(n²·k) without partitioning, ~10.6 µs per comparison.
- `:hasBlockingKey` — partitions the comparison space without deciding
  anything. Prefer it to a hard criterion: gating on a normalised name token
  would reject "Programme X" against "EU Programme X". A record with no blocking
  value is compared against everything rather than dropped.
- `:hasHardCriterion` — rejects outright. A valid partition, but only when
  differing values genuinely mean "not a match".
- `:maxMatchWorkers` — scoring fans out to worker threads above 200k pairs.
  Scoring parallelises where extract does not because it needs no query engine.

*Caveat:* a blocking key that is safe at your `:minScore` may not be below it.
Measure recall at the threshold you actually ship.

## Roadmap

- Testing
- Periodic harvesting
- `@directory-builder/create`: an npm initializer scaffolding a new use
  case, plus a `validate` command checking an instance setup
- `@directory-builder/ui`: extract the webapp into its own package
- ...
