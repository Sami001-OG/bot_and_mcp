import type { Metadata, Viewport } from 'next';
import './styles.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  ?? process.env.VERCEL_PROJECT_PRODUCTION_URL
  ?? process.env.VERCEL_URL
  ?? 'http://localhost:3000';
const metadataBase = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`);
const title = 'BOTX | Bybit Trading Command Center';
const description = 'Secure Bybit execution, TradingView automation, portfolio monitoring, and live risk controls in one trading command center.';

export const metadata: Metadata = {
  metadataBase,
  title: {
    default: title,
    template: '%s | BOTX',
  },
  description,
  applicationName: 'BOTX',
  category: 'finance',
  creator: 'BOTX',
  publisher: 'BOTX',
  referrer: 'origin-when-cross-origin',
  alternates: { canonical: '/' },
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico', type: 'image/x-icon' },
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    other: [{ rel: 'mask-icon', url: '/safari-pinned-tab.svg', color: '#7357ff' }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'BOTX',
  },
  formatDetection: { telephone: false, email: false, address: false },
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: '/',
    siteName: 'BOTX',
    title,
    description,
    images: [{
      url: '/opengraph-image.png',
      secureUrl: new URL('/opengraph-image.png', metadataBase),
      width: 1200,
      height: 630,
      type: 'image/png',
      alt: 'BOTX - Trading, under control.',
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
    images: [{ url: '/opengraph-image.png', alt: 'BOTX - Trading, under control.' }],
  },
  other: {
    'msapplication-TileColor': '#080a0e',
    'msapplication-config': '/browserconfig.xml',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#080a0e',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
