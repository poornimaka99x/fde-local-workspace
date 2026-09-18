# Hyperframes Composition Brief: FLOW

## Objective
Create a short launch-style brag video for FLOW, the local console and controller for governed multi-agent delivery work.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 20 seconds

## Source Material
- Project root: `/Users/poornimakahatapitiya/Library/CloudStorage/OneDrive-MaxedaDIYGroup/Maxeda/FDE-Agent/fde-local-workspace/fde-setup`
- Primary files read: `README.md`, `fde-gui/package.json`, `fde-gui/web/index.html`, `fde-gui/web/src/styles.css`, `fde-gui/web/src/features/runs/RoutingMatrix.tsx`, `fde-gui/web/src/lib/types.ts`
- Product name: FLOW
- Tagline / strongest claim: "Read-only is enforced, or it is not claimed."
- Key UI or visual moment to recreate: the routing/execution matrix (four distinct columns — account, method, model & effort, cost & ceiling) and the literal typed `APPROVE PLAN <run-id>` confirmation gate.
- Copy that must appear verbatim:
  - `Type exactly: APPROVE PLAN 20260918-…`
  - "Four different things. Never one badge."
  - "no --yolo. no danger-full-access. fde doctor fails if one ever appears."
  - "Read-only is enforced, or it is not claimed."
  - `FLOW` / `fde-start`

## Creative Direction
- Tone preset: polished
- Creative direction: a quiet, premium product film for infrastructure/governance tooling — restraint reads as competence to both a CTO and the engineer defending the decision later.
- Interpretation: fewer, longer-held scenes (4 total); confident pacing over frantic cuts; typography carries the story; nothing plays for a laugh — impressive claims are stated flatly and left alone.
- Angle: every other agent tool answers "what changed." FLOW answers what it was allowed to read, whose authority it acted on, and what you'd show a client who asked — and it proves that on screen, in its own real UI, not in marketing copy.
- Hook: a plain terminal-style line types out `Type exactly: APPROVE PLAN 20260918-…` character by character and stops. Nothing happens until it completes.
- Outro / punchline: "Read-only is enforced, or it is not claimed." → wordmark FLOW + `fde-start`.
- Avoid:
  - Generic SaaS language ("streamline your workflow" banned)
  - Abstract filler visuals (no stock motion graphics, no particle systems)
  - Unrelated visual redesign — use FLOW's actual palette and type, not a new brand

## Visual Identity
- Background: `#faf9f5` (warm paper)
- Text: `#1f1e1d`
- Accent: `#b0553a` (terracotta)
- Semantic: ok `#2c6e49`/`#e8f2ec`, warn `#8a5a12`/`#faf0dd`, danger `#a03530`/`#fbeceb`
- Display font: serif — "Iowan Old Style" / "Palatino Linotype" / Palatino / Georgia fallback stack
- Body font: system sans-serif stack; monospace (`ui-monospace`, "SF Mono", Menlo, Consolas) for the typed command, hashes, and matrix values
- Visual references from the project: the routing/execution matrix table, the typed `APPROVE PLAN <run-id>` confirmation line, the connector "blocked" badge with its reason text — all real UI moments from `fde-gui`, not recreations of the landing page.

## Storyboard
Use the storyboard in `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. The gate — 3s — the `APPROVE PLAN` phrase types out character by character and holds, completed.
2. The matrix unlocks — 6s — four matrix columns (account / method / model & effort / cost & ceiling) land one at a time under the line "Four different things. Never one badge."
3. Blocked, and it says why — 5s — a connector row flips to a red "blocked" badge with its real reason text, held to read.
4. The claim, then the mark — 6s — "Read-only is enforced, or it is not claimed." holds, then crossfades to the FLOW wordmark with `fde-start` beneath it.

## Audio
- Audio role: warm, restrained corporate bed — confidence, not hype
- Audio arc: enters low under the hook, small lift under the matrix reveal, settles for the blocked beat, fades cleanly under the final wordmark
- Music: `happy-beats-business-moves-vol-9-by-ende-dot-app.mp3`
- Music treatment: low volume throughout (target well below the track's natural energy), small lift (~+2-3dB) during Scene 2, settle back for Scene 3, clean fade-out across Scene 4
- Music cue guidance: bundled preset at the skill's `assets/music/cues/happy-beats-business-moves-vol-9-by-ende-dot-app.music-cues.json` / `.md` (114.84 BPM). Candidate strong cues near 3.70s (Scene 1→2 cut) and 8.44s (Scene 2→3 cut); treat as optional — do not sacrifice readability to hit them exactly.
- Audio-reactive treatment: subtle only — the matrix columns' arrival ticks may sit slightly on-beat; no waveform bars, no equalizer graphics, no pulsing background
- Audio-coupled moments:
  - Scene 1 — key-tick per typed character; one slightly heavier "confirm" tick when the phrase completes
  - Scene 2 — one soft tick per matrix column landing (4 total), evenly spaced, not beat-crammed
  - Scene 3 — a single low/dry tone synced to the "blocked" badge flip
  - Scene 4 — none; let the line and the mark land in near-silence as the music fades
- SFX selection guidance: sparse, motion-matched, professional restraint throughout; no comedic or bright/chime sounds — this is a governance tool, not a consumer app
- SFX analysis guidance: use `~/.claude-shared/fde-toolkit/plugins/fde-core/skills/brag/assets/sfx/sfx-analysis.md` for selection; prefer low high-frequency-risk sounds since this video repeats a similar tick motif four times
- Exact SFX choice: Hyperframes chooses exact filenames, timestamps, density, and volume based on the implemented animation
- Audio files: copy the chosen music into `brag-output/composition/assets/music/`; Hyperframes copies any selected SFX into the same `assets/` tree

## Hyperframes Instructions
Load the composition-building Hyperframes domain skills — `hyperframes-core` (composition contract + `data-*` timing), `hyperframes-animation` (motion), `hyperframes-creative` (design spec, beats, audio-reactive), `hyperframes-keyframes` (seek-safe keyframes), and `hyperframes-cli` (lint/check/render). This is `/brag`'s own workflow: do not enter the `hyperframes` entry-point intent interview and do not route into its generic promo/launch-video workflow. Prefer native Hyperframes conventions over anything hardcoded in `/brag`.

Requirements:
- Show at least one real UI, copy, or visual element from the source project (the matrix, the typed gate, the blocked badge).
- Keep all text readable in the final render — respect the reading-time floor from `brag-plan.md`.
- Keep the video within 15-25 seconds (target 20s).
- Include the planned music/SFX layer.
- Treat `/brag` audio notes as guidance, not a fixed cue sheet; choose SFX after the visual animation exists.
- Treat music cue metadata as optional timing hints; ignore cues that hurt readability, pacing, or the story.
- Use at most 1-3 strong-cue locks in this video.
- Use local assets for audio and any required runtime/media dependencies.
- Run `hyperframes check` before render — it is brag's single gate.
