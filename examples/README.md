# Examples

Examples in this directory use the local `run` package through pnpm's
`workspace:*` protocol.

Install workspace dependencies from the repository root:

```sh
pnpm install
```

Then run an example:

```sh
pnpm build:packages
pnpm tsx examples/basic.ts
export RUN_CONTINUATION_SECRET="$(openssl rand -base64 32)"
pnpm tsx examples/interruption.ts
```

Add new TypeScript example files here and execute them the same way.
