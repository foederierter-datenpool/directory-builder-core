# Migrating an instance repo

For maintainers of `funding-directory-builder` and `sosuse-directory-builder`.

Covers the CSV lift (already released in core **0.4.0**) and three engine changes
landing in the release after PRs #12, #13 and #14.

Nothing here is required on the day you upgrade. The CSV lift and the run-param
and harvest-time changes are additive and opt-in; the hard-criterion change is the
only one that can fail a run, and it fails at `validate`, before any data moves.

**Upgrade checklist**

1. Bump `@directory-builder/core` in `package.json`.
2. Run `directory-builder validate`. This is the gate — the hard-criterion check
   reports here, not mid-run.
3. Adopt whatever below is worth adopting. Most of it is optional.

---

## 1. CSV lifting — released in 0.4.0

A source declaring `:format ft:CSV` now lifts: first row as headers, one node per
data row, `xyz:<header>` literals. No `:hasLiftParam` needed.

Three things constrain it, all verified against the pinned SPARQL Anything v1.1.0:

- **The triplifier is chosen by file extension**, taken from the raw file's name.
  A `fetch.js` that writes without a `.csv` suffix silently gets the wrong
  triplifier.
- **Headers must be slugs** — ASCII letters, digits, underscore. Spaces and
  non-ASCII are percent-encoded into the predicate (`Max. Fördersumme` becomes
  `xyz:Max.%20F%C3%B6rdersumme`), and the map step additionally uses a
  `:fieldPath` as a SPARQL variable, which rules out `-` and `.` as well. A source
  whose export has prose headers must rewrite the header row in its `fetch.js`.
- **A UTF-8 BOM is stripped** by the triplifier. No workaround needed.

### funding-directory-builder

You are pinned to `^0.3.8`, which excludes 0.4.0, so you do not have the CSV lift
yet. Bump to `^0.4.0` to pick it up.

**Do not switch `fdbBund` to `:format ft:CSV`.** Its `fetch.js` already downloads
`programme.csv` and writes JSON, and that is the right call for a reason the CSV
lift does not address: the multi-valued columns (`funding_area`,
`eligible_applicants`, `funding_type`, …) carry a JSON-encoded array *inside one
cell*. Neither the CSV lift nor the extract step can turn one cell into several
bindings — SPARQL cannot split a string into multiple results. Parsing in
`fetch.js` keeps those arrays as arrays, which the JSON lift exposes as `rdf:_N`
sequences like every other list-valued source here. This is already documented in
`sources/fdbBund/fetch.js`; the CSV lift does not supersede it.

The CSV lift is worth reaching for on a *future* source whose cells are scalar.

### sosuse-directory-builder

Already on `^0.4.0`. No CSV source today, so nothing to do.

---

## 2. Per-source run params (PR #13)

A `:Source` may now declare `:hasRunParam`. Its values **replace** the
federation's of the same name outright — they do not append — and names the
source does not mention still come from the federation. The federation-wide
declaration keeps working unchanged, so doing nothing is safe.

### funding-directory-builder

You declare one federation-wide cap:

```turtle
:federation :hasRunParam [ :name "limit" ; :value "50" ] .
```

All four fetches read it (`fdbBund`, `foerderfinder`, `dsee`, `euportal`), and the
four sources have nothing in common — roughly 2500 rows in one lift file, 218 in
one, 1349 HTML pages at one JVM each, and 286,811 topics. One number cannot be
right for all of them. Now:

```turtle
:federation      :hasRunParam [ :name "limit" ; :value "50" ] .   # default for any source that says nothing
:fdbBundSource   :hasRunParam [ :name "limit" ; :value "0" ] .    # no cap: one lift file either way
:foerderfinderSource :hasRunParam [ :name "limit" ; :value "0" ] .
:dseeSource      :hasRunParam [ :name "limit" ; :value "200" ] .  # one JVM per page on lift
:euportalSource  :hasRunParam [ :name "limit" ; :value "500" ] .
```

This retires the `:enabled false` → ingest → restore dance, which is a manual
config edit mid-run that quietly drops sources from the federation if you forget
to undo it.

### sosuse-directory-builder

Your `plz` param is a *partition key* — 16 postal codes, each naming a complete
slice — not a cap, and partition keys are inherently per-source. `destatis` is an
XLSX source with national coverage and has no use for the same 16 codes as the
scraped sources. You can now narrow or replace the list per source:

```turtle
:destatisSource :hasRunParam [ :name "plz" ; :value "10115" ] .
```

Remember the replace semantics: a source listing one `plz` gets exactly that one,
not the federation's 16 plus one.

---

## 3. Harvest time in `extract.sparql` (PR #12)

Each extract now also sees one triple per source:

```turtle
cdp:fdbBundSource cdp:observedAt "2026-08-28T11:28:15.147Z"^^xsd:dateTime .
```

Opt-in — read it or ignore it:

```sparql
cdp:fdbBundSource cdp:observedAt ?observedAt .
```

The value is the *fetch* time, read from the ingest log on disk, so a
`federate`-only re-run keeps the previous ingest's timestamp. That is the point:
it is "as observed at", and it makes a time-relative derivation deterministic
where `NOW()` would give a different `directory.ttl` tomorrow.

Useful in `funding-directory-builder` if you want to decide whether a programme's
validity has lapsed, or to carry record staleness into a target field, without
putting that interpretation in `fetch.js`. No action required otherwise.

---

## 4. Hard criteria are now validated (PR #14)

This is the only change that can stop a run. It fails at `validate`, before
anything executes.

**What changed.** A hard criterion rejects a pair unless both records carry the
value, so a source that never fills the predicate stopped participating in
federation entirely — silently. Now:

- `validate` fails if an enabled source feeding a match rule's target supplies
  nothing for a predicate a hard criterion gates on.
- `:optional true` on a criterion relaxes it to "reject when both present and
  different" and exempts it from that check.
- A required value missing from the *data* (which config cannot see) is now
  counted and warned about during the run instead of passing unremarked.

A target field counts as supplied either by a `:hasFieldMapping` or, for an entity
link, by a `:hasRelationship` naming the same `:TargetField`. Engine-internal
`cdp:` predicates such as `cdp:matchString` are skipped, since `extract.sparql`
emits them and nothing in the config declares them.

### sosuse-directory-builder

**No action.** Verified: your config validates clean. Your three rules gate on
`schema:address`, `schema:provider`, `schema:postalCode` and `cdp:matchString` —
the first two are entity links declared via `:hasRelationship`, and `matchString`
comes from your extracts, so all are covered by the exemptions above. Re-run
`directory-builder validate` after upgrading to confirm against your then-current
config.

### funding-directory-builder

**No action, and no change to your conclusion.** Verified: your config validates
clean (you deliberately declare no `:hasHardCriterion`).

`:optional true` answers *one* of the three objections recorded in
`config/federation.ttl` — that a `dct:spatial` gate would foreclose whole sources,
since `euportal` emits none and 53 of 200 resolved records carry no location. It
does not answer the decisive one: the gate **never fires**, because
`token_sort_ratio` already scores the wrong-Land pairs far below the threshold.
Adding it with `:optional true` would still buy nothing. Leave it out.

The third objection also still stands, and is now documented in the engine:
`valOf` reads only a predicate's first quad, so **any hard criterion must be
single-valued**. A gate on a multi-valued field compares one arbitrary member, and
two records listing the same values in a different order fail it.

### Both repos

Watch for this line in a run — it is new, and it means records are sitting out of
the federation:

```
match: <rule> N of M entities carry no value for a required hard criterion and
can match nothing — declare :optional true on the criterion to let them fall through
```
