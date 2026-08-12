'use client';

import { geistShikiTheme } from '@vercel/geistdocs/shiki-theme';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import CodeMirror from '@uiw/react-codemirror';
import { useEffect, useState } from 'react';

type Language = 'javascript' | 'json';

const editorExtensions = {
  javascript: [javascript()],
  json: [json()],
};

const createPlaygroundHighlighter = async () => {
  const { createHighlighter } = await import('shiki/bundle/web');

  return createHighlighter({
    langs: ['javascript', 'json'],
    themes: [geistShikiTheme],
  });
};

let highlighterPromise:
  | ReturnType<typeof createPlaygroundHighlighter>
  | undefined;

const getHighlighter = () => {
  highlighterPromise ??= createPlaygroundHighlighter();
  return highlighterPromise;
};

function useHighlightedCode(code: string, language: Language) {
  const [html, setHtml] = useState('');

  useEffect(() => {
    let active = true;

    void getHighlighter().then(highlighter => {
      const highlighted = highlighter.codeToHtml(code, {
        lang: language,
        theme: geistShikiTheme.name,
      });

      if (active) {
        setHtml(highlighted);
      }
    });

    return () => {
      active = false;
    };
  }, [code, language]);

  return html;
}

interface HighlightedEditorProps {
  id: string;
  language: Language;
  onChange: (value: string) => void;
  value: string;
}

export function HighlightedEditor({
  id,
  language,
  onChange,
  value,
}: HighlightedEditorProps) {
  return (
    <CodeMirror
      aria-label={language === 'json' ? 'Input JSON' : 'Sandboxed JavaScript'}
      basicSetup={{
        bracketMatching: true,
        closeBrackets: true,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        lineNumbers: false,
      }}
      className="vbg-custom-editor"
      extensions={editorExtensions[language]}
      height="22rem"
      id={id}
      onChange={onChange}
      theme="light"
      value={value}
    />
  );
}

interface HighlightedCodeProps {
  code: string;
  language: Language;
}

export function HighlightedCode({ code, language }: HighlightedCodeProps) {
  const html = useHighlightedCode(code, language);

  return html ? (
    <div
      className="vbg-custom-highlighted-code"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <pre>
      <code>{code}</code>
    </pre>
  );
}
