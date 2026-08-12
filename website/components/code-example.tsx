'use client';

import { IconCheck } from '@vercel/geistdocs/assets/icons/icon-check';
import { IconCopy } from '@vercel/geistdocs/assets/icons/icon-copy';
import { useState } from 'react';

interface CodeExampleProps {
  code: string;
  highlightedCode: string;
}

export function CodeExample({ code, highlightedCode }: CodeExampleProps) {
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  const CopyIcon = copied ? IconCheck : IconCopy;

  return (
    <div className="run-code-frame">
      <div className="run-code-heading">
        <span>TypeScript</span>
        <div className="run-code-meta">
          <span>run.ts</span>
          <button
            aria-label={copied ? 'Code copied' : 'Copy code'}
            onClick={copyCode}
            title={copied ? 'Copied' : 'Copy code'}
            type="button"
          >
            <CopyIcon size={14} />
          </button>
        </div>
      </div>
      <div
        className="run-highlighted-code"
        dangerouslySetInnerHTML={{ __html: highlightedCode }}
      />
    </div>
  );
}
