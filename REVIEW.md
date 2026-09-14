# AI Code Review — repo facts for the review board

Read fresh on every `review run` in this repo (tool: `agent-system/tools/review/`,
spec: `agent-system/spec/review-board.md`). **Repo-specific facts only**: what to
enforce, what is noise, what not to flag. Keep it current.

## Stack

NanoClaw v2 fork (`luckylooke/nanoclaw`, branch `feat/native-credential-proxy`,
upstream `nanocoai/nanoclaw`). Host: TypeScript on Node, `pnpm test` (vitest),
`pnpm lint` (eslint), `pnpm typecheck` (tsc), prettier via the pre-commit hook.
Container runtime: `container/agent-runner/` runs under **Bun** inside the agent
image; its tests are `bun test` in the image.

## Rules to enforce

- **`container/agent-runner/src/**` is bind-mounted read-only at `/app/src` into every
  running agent container and has no build step — whatever is on disk is in production
  the instant it is written.** A file there that does not parse kills the whole fleet
  at startup while systemd still reports healthy (2026-08-03, three days). Every change
  there must transpile under Bun; `verify.js` does this in the real image.
- **Hooks in `container/agent-runner/src/providers/claude.ts` must never throw** — a
  throwing hook aborts the agent's turn. Wrap side effects, fail open, log.
- **Secrets never enter a container.** The credential proxy (`src/credential-proxy.ts`)
  injects keys host-side; a change that moves a key, token or `.env` value into a
  container mount, env or log is a critical finding.
- **Mount policy is an invariant with tests** (`src/mount-policy.test.ts`,
  `src/mount-composition.test.ts`): host-side privileged trees are read-only in
  containers, the intermediate directory is mounted over itself so the RO mounts
  cannot be escaped. A change to `buildMounts`/`privilegedRepoMounts` must keep them
  green and the escape invariant intact.
- **Cost attribution**: every model call carries `x-agent-group`; a new path that
  calls a model without it lands in the uncapped fail-open bucket (`gateway-db.ts`).
- **Never silence a check**: no `--no-verify`, no deleted or skipped test, no
  file-scope eslint-disable; a targeted disable needs a `--` reason.
- **Green before done**: `pnpm test && pnpm lint && pnpm typecheck`, and
  `node ~/agent-system/tools/verify/verify.js --full` before anything is called deployed.
- **Generated files are regenerated, not edited**: `container/agent-runner/src/mailbox/model.generated.ts`
  comes from `pnpm mailbox-model:generate`; `mailbox-model:check` must pass.

## Diff noise — exclude from review and from tier line-counts

- `pnpm-lock.yaml`
- `dist/`
- `**/*.generated.ts` — regenerated from a source file; drift is caught by `mailbox-model:check`
- `README_*.md` — upstream translations
- `CHANGELOG.md`

## Project-specific: do NOT flag

- Formatting — prettier runs in the pre-commit hook and rewrites `src/**/*.ts`.
- Upstream code style in files this fork did not touch; only the diff is under review.
- `console.log`/`console.error` in `scripts/` and CLI entry points.
- Long explanatory comments and commit messages — house style.

## Project-specific: extra attention

- `src/credential-proxy.ts`, `src/gateway-*.ts`, `src/mount-*.ts`, `src/modules/mount-security/`
- Anything under `container/agent-runner/src/` (live on save; Bun, not Node — no
  Node-only APIs without checking Bun supports them).
- `scripts/upgrade-state.ts` and the upstream-sync flow (`agent-system/tools/nanoclaw-upstream-check.js`).
- A test deleted or weakened in the same diff that changes the code it covered.

## Doc sync

- Status: **advisory** — `docs/` and `CLAUDE.md` describe architecture; a behaviour
  change they describe without an update is a warning.
