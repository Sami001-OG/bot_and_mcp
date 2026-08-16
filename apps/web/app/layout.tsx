import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: {
    default: 'NexusTrade Trading Terminal',
    template: '%s · NexusTrade',
  },
  description: 'Bybit execution, portfolio risk controls, and automated trading operations.',
  applicationName: 'NexusTrade',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    shortcut: '/favicon.ico',
    apple: '/apple-icon.png',
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: '/',
    siteName: 'NexusTrade',
    title: 'NexusTrade Trading Terminal',
    description: 'Bybit execution, portfolio risk controls, and automated trading operations.',
    images: [{ url: '/opengraph-image.png', width: 1200, height: 630, alt: 'NexusTrade Command Center' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'NexusTrade Trading Terminal',
    description: 'Bybit execution, portfolio risk controls, and automated trading operations.',
    images: ['/opengraph-image.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
