// A button that toggles a popover (click outside to close). The Map's source
// filter, the Merge type filter and the Merge "View" options all use it.

import React, { useEffect, useRef, useState } from "react"

const BTN = { padding: "0.25rem 0.6rem", border: "1px solid #aaa", borderRadius: 4, background: "white", cursor: "pointer", fontSize: 13 }

export default function Dropdown({ label, children }) {
    const [open, setOpen] = useState(false)
    const ref = useRef(null)
    useEffect(() => {
        if (!open) return
        const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
        document.addEventListener("mousedown", onDown)
        return () => document.removeEventListener("mousedown", onDown)
    }, [open])
    return (
        <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
            <button onClick={() => setOpen(!open)} style={BTN}>{label} ▾</button>
            {open && (
                <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 10, background: "white", border: "1px solid #aaa", borderRadius: 4, padding: 6, minWidth: 200, fontSize: 13, boxShadow: "0 2px 6px rgba(0,0,0,0.12)" }}>
                    {children}
                </div>
            )}
        </div>
    )
}
