import { defineConfig } from '@vercel/geistdocs/config';

export const config = defineConfig({
  title: 'run Documentation',
  logo: <span className="text-sm font-semibold text-gray-1000">run</span>,
  nav: [
    { label: 'Docs', href: '/docs' },
    { label: 'Playground', href: '/playground' },
  ],
  navbarVariant: 'oss',
  navbarActiveProduct: 'run',
  github: {
    owner: 'vercel-labs',
    repo: 'run',
    branch: 'main',
    editPath: 'content/docs/{path}',
  },
  content: [
    {
      id: 'docs',
      label: 'Docs',
      dir: 'content/docs',
      route: '/docs',
    },
  ],
  search: {
    enabled: true,
  },
  ai: {
    enabled: false,
  },
  agent: {
    enabled: false,
  },
  pageActions: {
    askAI: false,
    openInChat: false,
  },
  theme: {
    enabled: true,
  },
  translations: {
    en: {
      displayName: 'English',
    },
  },
});
