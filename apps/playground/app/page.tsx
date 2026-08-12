'use client';

import { type FormEvent, useState } from 'react';

const DEFAULT_INPUT = `{
  "name": "Vercel",
  "tags": ["sandboxed", "deterministic", "serverless"]
}`;

const DEFAULT_SOURCE = `const payload = await input.get();

return {
  greeting: \`Hello, \${payload.name}!\`,
  tags: payload.tags.map((tag) => tag.toUpperCase()),
  generatedAt: new Date().toISOString(),
};`;

const HOST_BINDING_SOURCE = `const result = await run({
  source,
  hostFunctions: {
    input: {
      get: () => inputPayload,
    },
  },
  limits: {
    maxBridgeRequests: 8,
    maxConsoleOutputBytes: 8 * 1024,
    maxHostFunctionArgumentsBytes: 8 * 1024,
    maxHostFunctionOutputBytes: 32 * 1024,
    maxInFlightBridgeRequests: 2,
    maxResultBytes: 64 * 1024,
    maxSourceBytes: 16 * 1024,
    memoryLimitBytes: 32 * 1024 * 1024,
    timeoutMs: 1_000,
  },
});`;

type ExecutionState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'success'; output: string }
  | { kind: 'error'; message: string };

const readErrorMessage = (value: unknown): string => {
  if (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null &&
    'message' in value.error &&
    typeof value.error.message === 'string'
  ) {
    return value.error.message;
  }
  return 'The function returned an unexpected response.';
};

export default function PlaygroundPage() {
  const [input, setInput] = useState(DEFAULT_INPUT);
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [execution, setExecution] = useState<ExecutionState>({ kind: 'idle' });

  const execute = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    let inputPayload: unknown;
    try {
      inputPayload = JSON.parse(input);
    } catch {
      setExecution({ kind: 'error', message: 'Input must be valid JSON.' });
      return;
    }

    setExecution({ kind: 'running' });

    try {
      const response = await fetch('/api/run', {
        body: JSON.stringify({ input: inputPayload, source }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const payload: unknown = await response.json();

      if (!response.ok) {
        setExecution({ kind: 'error', message: readErrorMessage(payload) });
        return;
      }

      setExecution({
        kind: 'success',
        output: JSON.stringify(payload, null, 2),
      });
    } catch {
      setExecution({
        kind: 'error',
        message: 'Could not reach the Vercel Function.',
      });
    }
  };

  const status =
    execution.kind === 'running'
      ? 'Executing guest code'
      : execution.kind === 'success'
        ? 'Execution completed'
        : execution.kind === 'error'
          ? 'Execution failed'
          : 'Ready to execute';

  return (
    <div className="vbg-shell">
      <a className="vbg-skip-link" href="#playground">
        Skip to playground
      </a>

      <header className="vbg-header">
        <div className="vbg-masthead">
          <a
            aria-label="Vercel"
            className="vbg-identity"
            href="https://vercel.com"
          >
            <span
              aria-label="Vercel"
              className="vbg-wordmark"
              role="img"
            />
          </a>
          <div className="vbg-document-meta">
            <span className="vbg-recipient">run</span>
            <span className="vbg-state">Playground</span>
          </div>
        </div>
      </header>

      <main id="playground">
        <section className="vbg-opening vbg-custom-opening">
          <div className="vbg-opening-claim">
            <h1 className="vbg-title">Run guest code against a host function.</h1>
          </div>
          <div className="vbg-opening-context">
            <p className="vbg-lede">
              Enter JSON and JavaScript. <code>run</code> executes your code in a secure QuickJS
              sandbox on a Vercel Function.
            </p>
          </div>
        </section>

        <form className="vbg-custom-workbench" onSubmit={execute}>
          <div className="vbg-custom-editors">
            <div className="vbg-custom-field">
              <div className="vbg-custom-field-heading">
                <label className="vbg-label" htmlFor="input">
                  Host input
                </label>
                <span className="vbg-meta">JSON</span>
              </div>
              <textarea
                className="vbg-custom-editor"
                id="input"
                onChange={event => setInput(event.target.value)}
                spellCheck={false}
                value={input}
              />
            </div>

            <div className="vbg-custom-field">
              <div className="vbg-custom-field-heading">
                <label className="vbg-label" htmlFor="source">
                  Guest source
                </label>
                <span className="vbg-meta">JavaScript</span>
              </div>
              <textarea
                className="vbg-custom-editor vbg-custom-editor-source"
                id="source"
                onChange={event => setSource(event.target.value)}
                spellCheck={false}
                value={source}
              />
            </div>
          </div>

          <div className="vbg-custom-execution">
            <div className="vbg-custom-action-row">
              <p aria-live="polite" className="vbg-meta" role="status">
                {status}
              </p>
              <button
                className="vbg-button"
                disabled={execution.kind === 'running'}
                type="submit"
              >
                {execution.kind === 'running' ? 'Running…' : 'Run code'}
              </button>
            </div>

            <div
              aria-live="polite"
              className="vbg-custom-output"
              data-state={execution.kind}
            >
              {execution.kind === 'success' ? (
                <pre>{execution.output}</pre>
              ) : execution.kind === 'error' ? (
                <p>{execution.message}</p>
              ) : (
                <p>
                  The serialized result from <code>run</code> will appear here.
                </p>
              )}
            </div>
          </div>
        </form>

        <section className="vbg-section vbg-custom-binding">
          <div className="vbg-split">
            <div className="vbg-span-4 vbg-custom-binding-copy">
              <h2 className="vbg-heading-24">The host function stays explicit.</h2>
              <p>
                Guest code can call <code>input.get()</code>. The binding
                crosses the sandbox boundary and returns only the JSON supplied
                above. Node.js APIs and application state are not exposed.
              </p>
              <p className="vbg-caption">
                The API route also applies strict time, memory, source, result,
                and bridge-request limits.
              </p>
            </div>
            <div className="vbg-span-8 vbg-custom-code-frame">
              <div className="vbg-custom-code-heading">
                <span className="vbg-label">Vercel Function</span>
                <span className="vbg-meta">app/api/run/route.ts</span>
              </div>
              <pre>
                <code>{HOST_BINDING_SOURCE}</code>
              </pre>
            </div>
          </div>
        </section>
      </main>

      <footer className="vbg-footer">
        <span aria-label="Vercel" className="vbg-logo" role="img" />
        <a href="https://github.com/vercel-labs/run">View run on GitHub</a>
      </footer>
    </div>
  );
}
