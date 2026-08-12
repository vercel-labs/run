'use client';

import { type FormEvent, useState } from 'react';
import {
  HighlightedCode,
  HighlightedEditor,
} from '@/components/highlighted-code';

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

const SANDBOX_LIMITS = [
  '1 second',
  '32 MB memory',
  '8 input.get() calls',
  'No network or Node.js APIs',
];

const HOST_BINDING_EXAMPLE = `const result = await run({
  source,
  hostFunctions: {
    input: {
      get: () => inputPayload,
    },
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
    <div className="vbg-report vbg-shell vbg-custom-type-scale">
      <a className="vbg-skip-link" href="#playground">
        Skip to playground
      </a>

      <main id="playground">
        <section className="vbg-opening vbg-custom-opening">
          <div className="vbg-opening-claim">
            <h1 className="vbg-title">Try the sandbox.</h1>
          </div>
          <div className="vbg-opening-context">
            <p className="vbg-lede">
              Change the input or code, then run it. This demo exposes one host
              function: <code>input.get()</code>.
            </p>
          </div>
        </section>

        <form className="vbg-custom-workbench" onSubmit={execute}>
          <div className="vbg-custom-editors">
            <div className="vbg-custom-field">
              <div className="vbg-custom-field-heading">
                <label className="vbg-label" htmlFor="input">
                  Input
                </label>
                <span className="vbg-meta">JSON · available through input.get()</span>
              </div>
              <HighlightedEditor
                id="input"
                language="json"
                onChange={setInput}
                value={input}
              />
            </div>

            <div className="vbg-custom-field">
              <div className="vbg-custom-field-heading">
                <label className="vbg-label" htmlFor="source">
                  Sandboxed code
                </label>
                <span className="vbg-meta">JavaScript</span>
              </div>
              <HighlightedEditor
                id="source"
                language="javascript"
                onChange={setSource}
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
                <HighlightedCode code={execution.output} language="json" />
              ) : execution.kind === 'error' ? (
                <p>{execution.message}</p>
              ) : (
                <p>
                  Run the code to see its return value.
                </p>
              )}
            </div>
          </div>
        </form>

        <section className="vbg-section vbg-custom-binding">
          <div className="vbg-split">
            <div className="vbg-span-4 vbg-custom-binding-copy">
              <h2 className="vbg-heading-24">What can the code access?</h2>
              <p>
                Only the functions listed in <code>hostFunctions</code>. In this
                demo, that is <code>input.get()</code>
              </p>
              <ul className="vbg-custom-limits">
                {SANDBOX_LIMITS.map(limit => (
                  <li key={limit}>{limit}</li>
                ))}
              </ul>
            </div>
            <div className="vbg-span-8 vbg-custom-code-frame">
              <div className="vbg-custom-code-heading">
                <span className="vbg-label">Host setup</span>
                <span className="vbg-meta">The trusted side</span>
              </div>
              <HighlightedCode
                code={HOST_BINDING_EXAMPLE}
                language="javascript"
              />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
