import { createMdxComponents } from '@vercel/geistdocs/mdx';
import type { MDXComponents } from 'mdx/types';

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return createMdxComponents(components);
}
