// Source selection persisted in the URL (?src=ca,dhs) so a filtered view is
// shareable and carries across the Entities and Map pages. Absent param means
// all sources; selecting all clears it back to a clean URL. The short codes are
// the sources' skos:notation.

import { useMemo } from "react"
import { useSearchParams } from "react-router-dom"

export function useSourceParam(sources) {
    const allIris    = useMemo(() => sources.map((s) => s.iri), [sources])
    const notationOf = useMemo(() => new Map(sources.map((s) => [s.iri, s.notation])), [sources])
    const iriOf      = useMemo(() => new Map(sources.map((s) => [s.notation, s.iri])), [sources])
    const [searchParams, setSearchParams] = useSearchParams()
    const visible = useMemo(() => {
        if (!searchParams.has("src")) return new Set(allIris)
        return new Set(searchParams.get("src").split(",").filter(Boolean).map((c) => iriOf.get(c)).filter(Boolean))
    }, [searchParams, allIris, iriOf])
    const setVisible = (next) => setSearchParams((prev) => {
        const p = new URLSearchParams(prev)
        const iris = allIris.filter((i) => next.has(i))
        iris.length === allIris.length ? p.delete("src") : p.set("src", iris.map((i) => notationOf.get(i)).join(","))
        return p
    }, { replace: true })
    return [visible, setVisible]
}
