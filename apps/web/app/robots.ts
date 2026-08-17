import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: [
          'Twitterbot',
          'facebookexternalhit',
          'LinkedInBot',
          'Slackbot',
          'Discordbot',
          'WhatsApp',
          'TelegramBot',
          'Applebot',
        ],
        allow: '/',
      },
      { userAgent: '*', disallow: '/' },
    ],
  };
}
