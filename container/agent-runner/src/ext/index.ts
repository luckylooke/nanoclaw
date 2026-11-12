/**
 * Fork features that attach through src/ext/seams.ts. Imported once from
 * src/modules/index.ts; each import registers at load time.
 */
// Order matters for env: otel-trace composes ANTHROPIC_CUSTOM_HEADERS.
import './otel-trace.js';
import './review-gate-hooks.js';
import './usage-footer.js';
