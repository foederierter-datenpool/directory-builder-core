// Reusable modal shell: dim backdrop (click to close) + a white box with a titled
// header and an × button. Used by the Match cluster popup and the Merge stats popup.

import React from "react"

export default function Modal({ title, onClose, children }) {
    return (
        <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 9999, display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: 60, overflowY: "auto" }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: "white", borderRadius: 6, padding: 20, minWidth: 480, maxWidth: 800, boxShadow: "0 8px 24px rgba(0,0,0,0.3)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, gap: 12 }}>
                    <h3 style={{ margin: 0, fontSize: 14 }}>{title}</h3>
                    <button onClick={onClose} style={{ border: 0, background: "transparent", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>×</button>
                </div>
                {children}
            </div>
        </div>
    )
}
