# Local geocoding for large instances

Nominatim setup for **instances with thousands of addresses**. By default it
imports the Germany OpenStreetMap extract and serves
address searches at `http://127.0.0.1:8088`. After the initial download and
import, geocoding works offline. Several instances can share the service;
each keeps its own `registry/geocache.json`. Harvesting mode is not required.

## Storage and prerequisites

- Docker with Compose v2 or newer; the pinned image supports ARM64 and AMD64.
- Enough host memory for Docker's `NOMINATIM_MEMORY` limit (default 8 GB),
  alongside other services.
- Storage for the downloaded extract, imported database and temporary import
  files. Germany's peak disk and memory requirements have not been measured
  with this setup; verify host capacity before starting that import.

The Compose file reduces the image's server-sized PostgreSQL memory defaults.
The `osm2pgsql.sh` wrapper caps the node cache at `OSM2PGSQL_CACHE_MB` (default
2048 MB), since automatic sizing can exceed the container limit. The defaults
use two import threads, four CPUs and one API worker.

For a 16 GB laptop, allocate about 10 GB to Docker Desktop and keep the
container's 8 GB limit. Stop other heavy containers during import. The
[Germany extract](https://download.geofabrik.de/europe/germany.html) is about
5 GB, but downloading it is only the first step: osm2pgsql reads its nodes,
ways and relations into PostgreSQL, then Nominatim computes addresses and
builds search indexes. This is disk- and memory-intensive work, not simply
unpacking the file. The API becomes available only after indexing finishes.

Allow **roughly 12–24 hours for the first Germany import** on a 16 GB laptop
with external SSD storage; it may take longer. Historical Germany imports
reported a final database around **100 GB**, but the size of this address-style
import has not yet been measured. Reserve **at least 200 GB free** in Docker's
data location, including room under Docker's disk-image limit, because the
download and temporary import files coexist with the growing database. Check
free space periodically. These are planning estimates, not guarantees; see
the [Nominatim import notes](https://nominatim.org/release-docs/5.3/admin/Import/)
and [reported Germany imports](https://github.com/mediagis/nominatim-docker/discussions/265).

An external hard drive is supported through Docker's storage configuration;
this setup uses standard Docker volumes and needs no code changes.

For recurring nationwide pipelines, run the geocoder on a shared server
alongside the pipeline. A local installation remains useful for pilots and
manual runs. Docker volumes hold the database. Local environment files, logs
and downloads here are ignored by Git. Keep each instance's address cache in
its registry workflow.
Compose ships with a fixed `NOMINATIM_PASSWORD` default. Use a unique value
in the deployment environment for shared servers.

## Start and check the service

From a core checkout (or the installed package's `tools/nominatim` directory):

```sh
cd tools/nominatim
docker compose up -d
docker compose logs -f --tail=100
```

No environment file is required: defaults live in `compose.yaml`. An optional
`.env` only needs the values you want to override.

The first start downloads Germany and imports it. Allow a long uninterrupted
run; the API starts only after import and indexing finish. `Ctrl+C` exits the
log viewer without stopping the service.

After an interrupted import, a verified complete extract in the project volume
can be reused with `PBF_URL=` and `PBF_PATH=/nominatim/data.osm.pbf` in `.env`.
The database import itself restarts from the beginning.

Check readiness separately:

```sh
docker compose ps
curl --fail 'http://127.0.0.1:8088/status?format=json'
curl --fail --get 'http://127.0.0.1:8088/search' \
  --data-urlencode 'street=Invalidenstraße 116' \
  --data-urlencode 'postalcode=10115' \
  --data-urlencode 'city=Berlin' \
  --data-urlencode 'country=DE' \
  --data-urlencode 'format=jsonv2' \
  --data-urlencode 'limit=1'
```

The API binds to localhost only; PostgreSQL has no host port. Replication and
optional Wikipedia, postcode and US address imports are disabled. There is no
flatnode volume. The database is frozen after a successful import.

For a smaller first test, create `.env.berlin` with just these overrides:

```dotenv
COMPOSE_PROJECT_NAME=directory-geocoder-berlin
PBF_URL=https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf
NOMINATIM_PORT=8089
NOMINATIM_MEMORY=6g
OSM2PGSQL_CACHE_MB=512
```

Use `docker compose --env-file .env.berlin up -d` and
`docker compose --env-file .env.berlin logs -f --tail=100`; test port 8089.
Stop this pilot before the Germany import so they do not compete for RAM.
The separate project gives Berlin its own volumes. Changing `PBF_URL` on an
already imported project does **not** replace its database.

## Use it from an instance

Use a core version containing these settings (or a linked local checkout),
existing ingest artifacts, and `:EnrichRule` / `:geocode` configured:

```sh
GEOCODE_ENDPOINT=http://127.0.0.1:8088/search \
GEOCODE_DATASET=germany \
GEOCODE_REQUIRE_LOCAL=true \
npx directory-builder federate
```

This fills the instance's address cache without publishing or pushing to GitHub.
Use the same variables with `npx directory-builder` for a full pipeline run;
ingestion can still need the network.

These settings belong to each instance's pipeline process. Core does not load
instance `.env` files automatically; export the variables or set them on the
command/container. The `.env` in this tools folder configures Docker Compose
only. Without a `:geocode` rule, the instance makes no geocoding requests.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEOCODE_ENDPOINT` | `http://127.0.0.1:8088/search` | Preferred Nominatim search URL; its sibling `/status?format=json` must report ready. Set the public search URL explicitly to skip local discovery. No query parameters or credentials. |
| `GEOCODE_DELAY_MS` | `0` | Delay between sequential requests. The public Nominatim host always retains a minimum 1100 ms delay, including after fallback. |
| `GEOCODE_DATASET` | unset | Label for the preferred service's region or dataset, e.g. `germany`. Change it when replacing an extract with different coverage at the same URL. |
| `GEOCODE_RETRY_MISSES` | `false` | `true` retries cached misses once per address during this run. Successful cached coordinates remain reusable. |
| `GEOCODE_CACHE_ONLY` | `false` | `true` prevents all geocoding requests and fails if a complete address is missing from the cache. |
| `GEOCODE_REQUIRE_LOCAL` | `false` | `true` stops the run when the configured non-public service is unavailable or a lookup fails, and rejects a public endpoint. |

Each address first checks the cache. On the first address needing a lookup or
a cached miss needing a dataset check, the pipeline probes the preferred
service once (three-second timeout). If ready, it handles this run's lookups;
otherwise the pipeline logs a warning and uses public Nominatim. A local
request failure also switches the remainder of the run to public Nominatim,
unless `GEOCODE_REQUIRE_LOCAL=true` makes either failure stop the run.
An empty search result is a valid miss and does not trigger public fallback.
A run with only cached coordinates makes no network requests or health probes.

Each new entry records the actual endpoint, plus the preferred service's
dataset label and `/status` OSM `data_updated` timestamp when available.
Cached misses are retried when any of these change. Use `GEOCODE_RETRY_MISSES=true`
to retry misses deliberately, including against the public endpoint.
Successful coordinates remain cached across provider and dataset changes.

Duplicate addresses share one result. Search requests are sequential and time
out after 60 seconds. The cache saves atomically every 100 completed addresses,
at completion and on handled request failures. Rerun to reuse saved work;
avoid simultaneous writers to one instance cache. Public fallback must still
respect Nominatim's [usage policy](https://operations.osmfoundation.org/policies/nominatim/):
use the local service for large national runs; recurring public bulk jobs
require at least `GEOCODE_DELAY_MS=15000` (four requests per minute).

For the Berlin extract, use `GEOCODE_ENDPOINT=http://127.0.0.1:8089/search`
and `GEOCODE_DATASET=berlin`. Set `GEOCODE_DATASET=germany` after importing
Germany so misses from the smaller extract are retried.

Normal recurring runs leave cache-only mode off so new addresses can be
geocoded. For reproducible reruns or CI with a filled cache, use:

```sh
GEOCODE_CACHE_ONLY=true npx directory-builder federate
```

A previously cached miss counts as known and still yields no coordinates;
an address lacking enough query fields is skipped as before. A newly seen
complete address aborts cache-only mode so it can be filled deliberately.
Cache-only mode also disables health probes and overrides retry-misses.

To query this service from a pipeline container, join both containers to a
shared Docker network and set `GEOCODE_ENDPOINT=http://nominatim:8080/search`.
Separate Compose projects do not share a network automatically. The runner
does not deploy Nominatim; `127.0.0.1` inside it refers to the runner itself.
On Docker Desktop, the host-published service can instead be reached at
`http://host.docker.internal:8088/search`.

## Stop, restart and rebuild

```sh
docker compose stop
docker compose up -d
```

A completed database survives stop/start, container recreation and ordinary
`docker compose down`. Startup is manual (no automatic restart policy).

An **interrupted initial import restarts from scratch** on the next start.
Inspect logs and fix disk or memory pressure before retrying.

For refreshed OSM data or a different region, use a new Compose project and
complete its import before replacing the old service. A frozen database cannot
apply replication updates. Keep the image pin with its volumes; image upgrades
may require rebuilding the database.

This explicitly deletes this project's database and project volumes
(including any downloaded extract):

```sh
docker compose down --volumes
```

Instance geocaches live outside Docker volumes and survive.

For the pilot, use `docker compose --env-file .env.berlin down --volumes`.

## References and attribution

Self-hosting removes the public API's rate limit, not OSM's attribution and
licensing requirements. Retain `© OpenStreetMap contributors` / ODbL attribution
in the cache and published outputs.

- [Nominatim import, memory use and freezing](https://nominatim.org/release-docs/5.3/admin/Import/)
- [Community Docker image and settings](https://github.com/mediagis/nominatim-docker/blob/master/howto.md)
- [Germany extracts](https://download.geofabrik.de/europe/germany.html)
- [OpenStreetMap attribution](https://www.openstreetmap.org/copyright)
