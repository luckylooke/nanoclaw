/**
 * Fork features that attach through src/ext/seams.ts. Imported once from
 * src/modules/index.ts; each import registers at load time.
 */
import './maintenance-gate.js';
import './webhook-rate-limit.js';
import './tool-proxy-socket.js';
// After the socket: same mount order as when both were inline in buildMounts.
import './ro-host-code-mounts.js';
