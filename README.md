# run workspace

This pnpm workspace contains the [`run`](packages/run) package.

## Development

Run commands from the workspace root:

```sh
pnpm install
pnpm build
pnpm test
pnpm type-check
pnpm check
```

## Changesets

Add a changeset for every release-worthy change:

```sh
pnpm changeset
```

Select the affected package and version bump, then describe the change. The
command creates a Markdown file in `.changeset/` that should be committed with
the change.
