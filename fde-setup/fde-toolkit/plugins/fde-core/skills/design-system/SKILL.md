---
name: design-system
description: Audit or evolve tokens, components, variants and accessibility across Figma and code, including Figma Code Connect mappings. Use whenever UI work changes a shared component or design and implementation have drifted.
argument-hint: "<run-id> <component or audit scope>"
allowed-tools: Read, Grep, Glob, Bash, Task, Write
---

# Design-system stewardship

After the guard, delegate to `design-system-steward`. Inventory code tokens,
components and stories plus Figma variables/components before changing either.
Produce a gap table: existing/reuse, extend, create, deprecate or exception.
Specify semantic tokens, variants, interaction/accessibility states and the
Figma-property-to-code-prop contract. Prefer Code Connect where supported.
Changes to shared components require impact analysis across consumers and
visual/accessibility verification. Do not introduce raw values or a new
component merely because the prototype used one.
