'use client';

import { useState } from 'react';

export function RunCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="run-command">
      <code>
        <span aria-hidden>$ </span>
        {command}
      </code>
      <button aria-label="Copy install command" onClick={copyCommand} type="button">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
