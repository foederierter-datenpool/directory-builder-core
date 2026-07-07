// A "?" help affordance: a small round button that opens a Modal explaining the
// page it sits on. Each page passes its own title + copy as children, so there's
// one help-icon implementation and one consistent look across every view.

import React, { useState } from "react"
import Modal from "./Modal.jsx"

export const HELP_ICON = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: "50%", border: "1px solid #bbb", background: "white", color: "#777", fontSize: 11, lineHeight: 1, cursor: "pointer", userSelect: "none", fontWeight: 700, padding: 0, flex: "none" }

export default function HelpTip({ title, label = "About this page", children }) {
    const [open, setOpen] = useState(false)
    return (
        <>
            <button style={HELP_ICON} onClick={() => setOpen(true)} aria-label={label} title={label}>?</button>
            {open && (
                <Modal title={title} onClose={() => setOpen(false)}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: 13, lineHeight: 1.55, color: "#444", maxWidth: 600 }}>
                        {children}
                    </div>
                </Modal>
            )}
        </>
    )
}
