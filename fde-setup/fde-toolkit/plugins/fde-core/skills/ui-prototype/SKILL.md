---
name: ui-prototype
description: Create and review user flows and UI prototypes in Figma or Claude Design before implementation, covering all states, responsive behaviour and accessibility. Use for new screens, workflow changes or design validation.
argument-hint: "<run-id> <screen or workflow>"
allowed-tools: Read, Grep, Glob, Bash, Task, Write
---

# UI prototype

Guard the run, then delegate to `ui-ux-designer`. Start from the product brief,
existing UI and design system. Choose the surface explicitly: Figma for shared,
inspectable design and handoff; Claude Design for rapid exploration; code only
when the user asks for an executable prototype. Define the flow before visual
polish and include loading, empty, error, validation, permission, success,
responsive, keyboard and reduced-motion states. Record design rationale,
unresolved product decisions and the Figma/file URL in the run. Do not treat a
single screenshot as an implementation specification. Route component changes
through `design-system` and implementation through `design-to-code`.
