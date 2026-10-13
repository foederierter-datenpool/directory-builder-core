// A changed selection loads its details; late results cannot replace a newer page.
import { useEffect, useState } from "react"

export function usePageData(load, items) {
    const [result, setResult] = useState(null)
    const [failure, setFailure] = useState(null)
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
        let cancelled = false
        setFailure(null)
        load(items).then(
            data => { if (!cancelled) setResult({ items, data }) },
            error => { if (!cancelled) setFailure({ items, error }) })
        return () => { cancelled = true }
    }, [load, items, attempt])
    const error = failure?.items === items ? failure.error : null
    return { data: result?.items === items ? result.data : undefined, error,
        loading: result?.items !== items && !error, retry: () => setAttempt(n => n + 1) }
}
