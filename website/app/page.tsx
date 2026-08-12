import { Button } from '@vercel/geistdocs/components/button';
import Link from 'next/link';
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

export default function Home() {
  return (
    <main className="run-home">
      <section className="run-hero">
        <div className="run-hero-glow" aria-hidden />
        <div className="run-hero-content">
          <p className="run-eyebrow">Secure code execution for AI applications</p>
          <h1>Run untrusted code. Keep control.</h1>
          <p className="run-lede">
            A TypeScript package for executing JavaScript in a hardened sandbox
            with explicit host functions, resource limits, and resumable
            interruptions.
          </p>
          <div className="run-audience" aria-label="Designed for">
            <span>For applications</span>
            <span aria-hidden>/</span>
            <span>For agents</span>
          </div>
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
          <p className="run-kicker">One boundary. Your capabilities.</p>
          <h2>Give generated code exactly what it needs.</h2>
          <p>
            Guest source can use top-level <code>await</code> and{' '}
            <code>return</code>. It can only reach your application through
            host functions you explicitly provide.
          </p>
          <Link className="run-text-link" href="/docs/foundations/overview">
            Learn how the sandbox works <span aria-hidden>→</span>
          </Link>
        </div>
        <div className="run-code-frame">
          <div className="run-code-heading">
            <span>TypeScript</span>
            <span>run.ts</span>
          </div>
          <pre>
            <code>{example}</code>
          </pre>
        </div>
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
        <h2>Build the capability, not the escape hatch.</h2>
        <Button asChild size="lg" variant="outline">
          <Link href="/docs">Explore the documentation</Link>
        </Button>
      </section>
    </main>
  );
}
