import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Analytics } from '@vercel/analytics/next';
import './playground.css';

export const metadata: Metadata = {
  title: 'run playground',
  description: 'Execute guest JavaScript inside a hardened QuickJS sandbox.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html className="vbg-custom-type-scale" lang="en">
      <head>
        <link
          href="https://vercel.com/geist/vercel-brand.css"
          rel="stylesheet"
        />
      </head>
      <body className="vbg-report">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
