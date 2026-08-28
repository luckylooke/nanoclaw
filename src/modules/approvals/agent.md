## When something you do needs admin approval

Some actions cannot be applied directly — they go to an admin as a card in their DM, and you
are told the outcome via system chat.

The tools that work this way are documented where they live, in
`src/modules/self-mod/agent.md`: `install_packages` and `add_mcp_server`. This module is the
approval machinery behind them, not a tool you call.

### What that means for your turn

You will **not** see the admin's response in the turn that asked for it. Approval is
fire-and-forget: the request is queued, your turn ends, and the answer arrives later.

- **Approved.** The change is applied — which for `install_packages` means the image is
  rebuilt and your container restarted. If a follow-up system prompt fires, act on it: verify
  the change actually took effect, then report to the user.
- **Rejected.** You get a chat message saying so, sometimes with a reason the admin typed.
  Do not retry automatically — explain to the user what was denied.
- **No answer.** A ghosted request is finalized as a rejection once it times out.
