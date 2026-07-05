// A small "?" icon that shows a short explanatory popover on hover — instant, no
// click. Pass the explanation as children; keep it to a sentence or two of
// gentle guidance.

import React, { useState } from "react"

const ICON = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: "50%", border: "1px solid #bbb", color: "#777", fontSize: 11, lineHeight: 1, cursor: "help", userSelect: "none", fontWeight: 700 }
const CARD = { position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 50, width: 300, background: "white", border: "1px solid #ccc", borderRadius: 6, padding: "9px 11px", fontSize: 12, lineHeight: 1.5, color: "#444", fontWeight: 400, boxShadow: "0 4px 14px rgba(0,0,0,0.14)" }

export default function InfoTip({ children, width }) {
    const [open, setOpen] = useState(false)
    return (
        <span style={{ position: "relative", display: "inline-flex" }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
            <span style={ICON} title="What's this?" aria-label="Help">?</span>
            {open && <span style={{ ...CARD, ...(width ? { width } : {}) }}>{children}</span>}
        </span>
    )
}
