## Approvals module

Admin-gated approval **primitive**: any module can ask an admin to authorize an action and
get a callback when they answer. Lives in `src/modules/approvals/`. Default-tier, ships with
main.

### The flow

A module calls `requestApproval(...)` with a free-form `action` string. The module delivers a
card to the approver's DM and persists a `pending_approvals` row. When the admin clicks a
button, the registered response handler looks the row up and dispatches to whichever module
called `registerApprovalHandler(action, handler)`. The agent is notified via system chat on
approve or reject.

**Reject with reason.** "Reject with reason…" holds the row instead of finalizing, and
`reason-capture.ts` registers a message interceptor that captures the admin's next DM as the
rejection reason. If the admin never answers, `sweepAwaitingReasonRejects` — called from
`host-sweep.ts` — finalizes the ghosted hold once it times out.

### Public API

Re-exported from the module root, so consumers import `modules/approvals/index.js` rather
than reaching at files: `requestApproval`, `registerApprovalHandler`, `notifyAgent`,
`sweepAwaitingReasonRejects`, and the `ApprovalHandler` / `ApprovalHandlerContext` /
`RequestApprovalOptions` types.

### Wiring

- **Response handler** — `registerResponseHandler(handleApprovalsResponse)` runs on import
  and is the module's *only* registration. It claims `pending_approvals` rows and dispatches
  by `action`.
- **Message interceptor** — registered by `reason-capture.ts`, which loads via the
  `sweepAwaitingReasonRejects` re-export in `index.ts`.

There is no adapter-ready hook and no host-shutdown hook. `e4746380` removed the fork's dead
duplicate shutdown registry, and `host-lifecycle.test.ts` now asserts the real invariant:
importing this module registers nothing but the response handler.

### Tables

`pending_approvals`, created by `module-approvals-pending-approvals.ts`; later columns come
from `013-approval-render-metadata`, `018-approvals-approver-user-id`, `021-approval-question`
and `023-approvals-instance`. Not dropped on uninstall — approvals in flight aren't lost on
reinstall.

### Core integration

Host-side infra only, no reaching into core decision paths: `wakeContainer`
(container-runner), `writeSessionMessage` (session-manager), `getDeliveryAdapter` (delivery),
`registerMessageInterceptor` (router), `registerResponseHandler` (response-registry),
`normalizeOptions` (channels/ask-question), and the `pending_approvals` helpers in
`db/sessions.ts`.

### Consumers

- `src/modules/self-mod/` — `install_packages` and `add_mcp_server` moved out of this module
  in PR #7 and now go through the public API.
- `src/cli/dispatch.ts` — CLI-requested approvals.
- `src/host-sweep.ts` — `sweepAwaitingReasonRejects`.

Removing the module: delete `src/modules/approvals/` and its import from
`src/modules/index.ts`. Button clicks on approval cards will log "Unclaimed response", and
stale rows remain in `pending_approvals` until manual cleanup.

### Gone: the OneCLI credential flow

`onecli-approvals.ts` (action `onecli_credential`, a long-poll the OneCLI gateway held open
while waiting for admin approval) was deleted in `57b86eee`, when the fork replaced the
OneCLI gateway with the native credential proxy — `src/gateway-providers/credential-proxy.ts`.
Upstream still ships that file; this fork does not, on purpose, because no agent is ever
shown a secret and no secret enters model context. The module has no card-edit path today.
