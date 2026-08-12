import { Button } from '@vercel/geistdocs/components/button';
import { geistShikiTheme } from '@vercel/geistdocs/shiki-theme';
import Link from 'next/link';
import { codeToHtml } from 'shiki';
import { CodeExample } from '@/components/code-example';
import { RunCommand } from '@/components/run-command';

const example = `import { run } from 'run';

const result = await run({
  source: \`
    const doubled = await tools.double(21);
    return { message: 'Hello from the sandbox!', doubled };
  \`,
  hostFunctions: {
    tools: {
      double: (value: number) => value * 2,
    },
  },
});

if (result.status === 'completed') {
  console.log(result.value);
}`;

const features = [
  {
    title: 'Hardened by default',
    description:
      'Every invocation runs in a fresh QuickJS context without ambient access to Node.js, files, environment variables, modules, or the network.',
  },
  {
    title: 'Explicit capabilities',
    description:
      'Expose only the host functions your guest code needs. Inputs and outputs cross a serialized boundary you control.',
  },
  {
    title: 'Built for long-running work',
    description:
      'Interrupt execution for approval or authentication, then resume from a signed continuation without repeating completed work.',
  },
];

export default async function Home() {
  const highlightedExample = await codeToHtml(example, {
    lang: 'typescript',
    theme: geistShikiTheme,
  });

  return (
    <main className="run-home">
      <section className="run-hero">
        <div className="run-hero-content">
          <h1>Run untrusted TypeScript.</h1>
          <p className="run-lede">
            Execute agent-generated code in a hardened sandbox.
          </p>
          <RunCommand command="pnpm add run" />
          <div className="run-actions">
            <Button asChild size="lg">
              <Link href="/docs/introduction">Read the docs</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/playground">Open playground</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="run-quickstart">
        <div className="run-section-copy">
          <h2>Give code only what it needs.</h2>
          <p>Guest code accesses only the host functions you provide.</p>
          <Link className="run-text-link" href="/docs/foundations/overview">
            Learn how the sandbox works <span aria-hidden>→</span>
          </Link>
        </div>
        <CodeExample code={example} highlightedCode={highlightedExample} />
      </section>

      <section className="run-features" aria-label="Features">
        {features.map(feature => (
          <article key={feature.title}>
            <span className="run-feature-mark" aria-hidden />
            <h2>{feature.title}</h2>
            <p>{feature.description}</p>
          </article>
        ))}
      </section>

      <section className="run-cta">
        <h2>Learn more about run</h2>
        <Button asChild size="lg" variant="outline">
          <Link href="/docs">Explore the documentation</Link>
        </Button>
      </section>
    </main>
  );
}
