// Pi entry — binds host="pi" into the shared pi-API register factory.
// Built into the @evo-hq/pi-evo npm package via npm/scripts/sync-from-source.sh.
//
// Pi and openclaw share the same ExtensionAPI shape (openclaw embeds pi
// as its upstream SDK), so the underlying logic is identical. Only the
// host string differs — making pi sessions visible as "pi" rather than
// being mistagged as "openclaw" in evo's registry and dashboard.

import { makeRegister } from "./factory.js"

export default makeRegister("pi")
