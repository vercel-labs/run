# run

`run` executes untrusted JavaScript and type-stripped TypeScript in a hardened
QuickJS sandbox. Guest code can access only the host functions you provide.

## Quick start

```sh
pnpm add run
```

Supports Node.js 22.13 or newer and Bun.

```ts
import { run } from 'run';

const result = await run({
  source: `
    const orders = await store.listOrders('customer_123');
    return orders.reduce((total, order) => total + order.amount, 0);
  `,
  hostFunctions: {
    store: {
      listOrders: (customerId: string) =>
        database.orders.findMany({ customerId }),
    },
  },
});

if (result.status === 'completed') {
  console.log(result.value);
}
```

The generated program can call `store.listOrders()`, while the database client
and its credentials stay in your application.

## Features

- Every invocation gets a fresh QuickJS context in a worker thread, with no
  ambient Node.js, filesystem, module, or network access.
- A host function can interrupt a run for approval or authentication. The run
  resumes without repeating host calls that already completed.
- Time, memory, result size, and concurrency are capped, per run or per runner.

`run` is for sandboxed JavaScript computation inside an application. Workloads
that need an operating system, package installation, or process-level isolation
should use Vercel Sandbox.

## Documentation

Start with the [introduction](content/docs/introduction/index.mdx), then the
[foundations](content/docs/foundations/overview.mdx) and the
[API reference](content/docs/reference/index.mdx).

## Development

`pnpm check` runs formatting, static analysis, and the fail-closed banned-pattern
security scan. A local `@banned-pattern-ignore` is accepted only when it states
a concrete safety reason and suppresses an actual finding; stale suppressions
fail the scan.

## License

[Apache 2.0](LICENSE)
