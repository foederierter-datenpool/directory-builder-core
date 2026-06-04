// Browser entry point: mounts the React app into the page.
// Reads:  App.jsx
// Does:   renders <App> into the #root element

import { createRoot } from "react-dom/client"
import App from "./App.jsx"
import React from "react"

createRoot(document.getElementById("root")).render(<App />)
