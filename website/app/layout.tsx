import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Analytics } from '@vercel/analytics/next';
import { Footer } from '@vercel/geistdocs/footer';
import { Navbar } from '@vercel/geistdocs/navbar';
import { GeistdocsProvider } from '@/components/geistdocs/provider';
import { config } from '@/lib/geistdocs/config';
import { mono, sans } from '@/lib/geistdocs/fonts';
import './globals.css';
import './playground.css';

export const metadata: Metadata = {
  title: {
    default: 'run — Secure code execution for AI applications',
    template: '%s | run',
  },
  description:
    'Execute untrusted JavaScript and TypeScript in a hardened QuickJS sandbox with explicit host functions and resumable interruptions.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
      lang="en"
      suppressHydrationWarning
    >
      <head>
        <link
          href="https://vercel.com/geist/vercel-brand.css"
          rel="stylesheet"
        />
      </head>
      <body className="flex min-h-full flex-col">
        <GeistdocsProvider>
          <Navbar config={config} />
          {children}
          <Footer />
        </GeistdocsProvider>
        <Analytics />
      </body>
    </html>
  );
}
