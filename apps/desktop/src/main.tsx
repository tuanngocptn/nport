import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import "./styles.css"

const root = document.getElementById("root")
if (!root) {
  // `index.html` is ours, so this cannot happen in a shipped build — but the alternative to
  // throwing is a non-null assertion, which `noNonNullAssertion` forbids for exactly this reason:
  // it turns a clear message into "cannot read properties of null".
  throw new Error("index.html is missing #root")
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
