# Durable order automation

This example combines the Workflow SDK for durable orchestration with the Run
SDK for sandboxed dynamic code. The program reads an order, interrupts before a
refund, waits for an authorized decision, and resumes from a Run continuation.

The UI and stores are intentionally small. `x-demo-role` is a local stand-in for
session authentication, and the order store is process memory. Replace both
adapters in a real application.

## Run it

From the repository root:

```sh
pnpm install
pnpm build:packages
export RUN_CONTINUATION_SECRET="$(openssl rand -base64 32)"
pnpm --filter @run/durable-order-automation-example dev
```

Open [http://localhost:3000](http://localhost:3000), run the preloaded source,
then approve or reject its refund request.

The terminal prints the approval payload and hook token to make the protocol
visible. Both the Workflow hook token and Run continuation are sensitive bearer
values; production applications should keep them server-side and out of logs.

## Test durability

1. Start an automation and wait until the UI says **Waiting for approval**.
2. Stop the development server with `Ctrl+C`. No Run worker remains suspended.
3. Start the same command again without deleting `.workflow-data`.
4. Reload the existing browser URL. It includes the automation and workflow run
   IDs needed to reconnect.
5. Approve the refund.

The workflow resumes after the process restart and completes the Run
continuation. The terminal logs `orders.get` before the wait and does not log it
again after resumption, because Run replays the recorded result. It logs one
`orders.refund` after approval.

You can inspect the local Workflow event log in another terminal:

```sh
pnpm --filter @run/durable-order-automation-example exec workflow inspect runs
```

## Run tests

```sh
pnpm build:packages
pnpm --filter @run/durable-order-automation-example test
pnpm --filter @run/durable-order-automation-example type-check
```

The tests cover completion without approval, approval, rejection, replay,
sequential approval rounds, interruption batches, and continuation scope
mismatch. Use the restart exercise above to test the Workflow hook lifecycle.

## Boundaries

- `src/workflow` contains trusted durable orchestration.
- `src/steps` contains retryable Node.js work and the Run invocation.
- `src/sandbox` defines the runner and narrow host capabilities.
- `src/api` authenticates callers before starting or resuming a workflow.
- `src/domain` contains serializable protocol types and the demo order adapter.
- `public` contains the small approval UI.

The runner, host functions, credentials, and order store never cross the
Workflow serialization boundary. Initial execution and resumption both use
`runAutomationRound()`, which keeps source, audience, host-function names, and
continuation context consistent.
