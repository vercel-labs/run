import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const expected = [
  {
    license: 'MIT',
    name: 'devalue',
    version: '5.8.2',
  },
  {
    license: 'MIT',
    name: 'quickjs-wasi',
    version: '3.5.0',
  },
];

async function findManifest(packageName) {
  let directory = dirname(require.resolve(packageName));

  while (true) {
    const manifestPath = join(directory, 'package.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.name === packageName) {
        return manifest;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not locate the manifest for ${packageName}`);
    }
    directory = parent;
  }
}

const inventory = await Promise.all(
  expected.map(async expectedPackage => {
    const manifest = await findManifest(expectedPackage.name);
    const actual = {
      license: manifest.license,
      name: manifest.name,
      version: manifest.version,
    };

    for (const field of ['name', 'version', 'license']) {
      if (actual[field] !== expectedPackage[field]) {
        throw new Error(
          `Embedded dependency ${expectedPackage.name} has unexpected ${field}: ` +
            `${String(actual[field])}; expected ${expectedPackage[field]}`,
        );
      }
    }

    return actual;
  }),
);

process.stdout.write(
  `${JSON.stringify(
    {
      dependencies: inventory,
      format: 'run-embedded-dependency-inventory',
      version: 1,
    },
    null,
    2,
  )}\n`,
);
