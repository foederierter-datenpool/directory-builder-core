// Source selection persisted in the URL (?src=ca,dhs) so a filtered view is
// shareable and carries across pages that read it (the short codes are the
// sources' skos:notation). Absent param means the page's default selection: all
// sources, or just the first when a page passes { defaultFirst: true } (Map,
// where every source at once is too dense). Selecting exactly the default clears
// the param back to a clean URL; an explicit ?src= overrides the default on any
// page. Nav links drop the query, so pages apply their own default on arrival.

import { useMemo } from "react"
import { useSearchParams } from "react-router-dom"

export function useSourceParam(sources, { defaultFirst = false } = {}) {
    const allIris     = useMemo(() => sources.map((s) => s.iri), [sources])
    const notationOf  = useMemo(() => new Map(sources.map((s) => [s.iri, s.notation])), [sources])
    const iriOf       = useMemo(() => new Map(sources.map((s) => [s.notation, s.iri])), [sources])
    const defaultIris = useMemo(() => (defaultFirst ? allIris.slice(0, 1) : allIris), [allIris, defaultFirst])
    const [searchParams, setSearchParams] = useSearchParams()
    const visible = useMemo(() => {
        if (!searchParams.has("src")) return new Set(defaultIris)
        return new Set(searchParams.get("src").split(",").filter(Boolean).map((c) => iriOf.get(c)).filter(Boolean))
    }, [searchParams, defaultIris, iriOf])
    const setVisible = (next) => setSearchParams((prev) => {
        const p = new URLSearchParams(prev)
        const iris = allIris.filter((i) => next.has(i))
        const isDefault = iris.length === defaultIris.length && iris.every((i) => defaultIris.includes(i))
        isDefault ? p.delete("src") : p.set("src", iris.map((i) => notationOf.get(i)).join(","))
        return p
    }, { replace: true })
    return [visible, setVisible]
}
