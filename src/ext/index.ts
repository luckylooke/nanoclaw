/**
 * Fork features that attach through src/ext/seams.ts. Imported once from
 * src/modules/index.ts; each import registers at load time.
 */
import './credential-proxy-server.js';
import './maintenance-gate.js';
import './webhook-rate-limit.js';
import './tool-proxy-socket.js';
// After the socket: same mount order as when both were inline in buildMounts.
import './ro-host-code-mounts.js';
import './adaptive-tuning.js';
import './prompt-fragments.js';
import './memory-index.js';
import './usage-footer.js';
