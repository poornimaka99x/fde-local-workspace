#!/usr/bin/env node

// FDE entry point for the vendored skill package. Disable Archify's optional
// update request: FDE upgrades are explicit, checksum-pinned operator actions.
process.env.ARCHIFY_UPDATE_CHECK_DISABLED = '1';
await import('../skills/archify/bin/archify.mjs');
