import '@testing-library/jest-dom/vitest'

// xterm feature-detects colour support when the login panel module is loaded.
// jsdom deliberately has no canvas implementation; this inert stub is enough
// for that detection and keeps unrelated form tests quiet.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
}
