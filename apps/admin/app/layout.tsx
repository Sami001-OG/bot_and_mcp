import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_ADMIN_URL ?? 'http://localhost:3001'),
  title: 'NexusTrade Operations Console',
  description: 'Secure multi-exchange trading operations and administration.',
  applicationName: 'NexusTrade Admin',
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
    title: 'NexusTrade Operations Console',
    description: 'Secure multi-exchange trading operations and administration.',
    images: [{ url: '/opengraph-image.png', width: 1200, height: 630, alt: 'NexusTrade Operations Console' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'NexusTrade Operations Console',
    description: 'Secure multi-exchange trading operations and administration.',
    images: ['/opengraph-image.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
