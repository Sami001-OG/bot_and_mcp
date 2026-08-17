import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'NexusTrade Trading Command Center',
    short_name: 'NexusTrade',
    description: 'Secure Bybit execution, TradingView automation, portfolio monitoring, and live risk controls.',
    start_url: '/',
    display: 'standalone',
    background_color: '#080a0e',
    theme_color: '#080a0e',
    orientation: 'any',
    categories: ['finance', 'business', 'productivity'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
