# run

`run` executes untrusted JavaScript and type-stripped TypeScript in a hardened
QuickJS sandbox. Guest code can access only the host functions you provide.

## Quick start

```sh
pnpm add run
```

Requires Node.js 22.13 or newer.

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

- **Hardened execution** - every invocation uses a fresh QuickJS context in a
  worker thread, with no ambient Node.js, filesystem, module or network access.
- **Human-in-the-loop** - interrupt for approval or authentication, then resume
  without repeating completed host calls.
- **Resource controls** - set time, memory, result size and concurrency limits.

`run` is designed for sandboxed JavaScript computation inside an application.
Workloads that need an operating system, package installation, or process-level
isolation should use Vercel Sandbox.

## Documentation

Read the [introduction](content/docs/introduction/index.mdx), explore the
[foundations](content/docs/foundations/overview.mdx), or browse the
[API reference](content/docs/reference/index.mdx).

## License

[Apache 2.0](LICENSE)
