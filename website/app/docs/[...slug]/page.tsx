import { MobileDocsBar } from '@vercel/geistdocs/mobile-docs-bar';
import { createDocsPage } from '@vercel/geistdocs/pages/docs';
import { getMDXComponents } from '@/components/geistdocs/mdx-components';
import { config } from '@/lib/geistdocs/config';
import { geistdocsSource } from '@/lib/geistdocs/source';

const docsPage = createDocsPage({
  config,
  mdx: getMDXComponents(),
  source: geistdocsSource,
  tableOfContentPopover: {
    enabled: false,
  },
  renderTop: ({ data }) => <MobileDocsBar toc={data.toc} />,
});

type PageParams = { slug: string[] };

export default function DocsPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  return docsPage.Page({
    params: params.then(({ slug }) => ({ lang: 'en', slug })),
  });
}

export function generateStaticParams() {
  return docsPage
    .generateStaticParams()
    .filter(param => param.lang === 'en' && param.slug?.length)
    .map(({ slug }) => ({ slug: slug as string[] }));
}

export function generateMetadata({
  params,
}: {
  params: Promise<PageParams>;
}) {
  return docsPage.generateMetadata({
    params: params.then(({ slug }) => ({ lang: 'en', slug })),
  });
}
