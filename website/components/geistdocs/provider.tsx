'use client';

import { GeistdocsProvider as PackageProvider } from '@vercel/geistdocs/layout';
import type { ComponentProps } from 'react';
import { config } from '@/lib/geistdocs/config';

type ProviderProps = Omit<ComponentProps<typeof PackageProvider>, 'config'>;

export function GeistdocsProvider(props: ProviderProps) {
  return <PackageProvider config={config} {...props} />;
}
