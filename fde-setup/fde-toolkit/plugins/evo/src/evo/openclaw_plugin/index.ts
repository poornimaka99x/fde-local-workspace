// Openclaw entry — binds host="openclaw" into the shared pi-API register
// factory. Built into evo.bundle.js for the openclaw plugin install.
//
// See factory.ts for the shared logic and why host parameterization
// matters. See notes/cross-host-inject-design.md for the broader design.

import { makeRegister } from "./factory.js"

export default makeRegister("openclaw")
