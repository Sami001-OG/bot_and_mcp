import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'apps', 'web', 'public');

const mark = `
  <path d="M144 344V168l112 176 112-176v176" fill="none" stroke="url(#mark)" stroke-width="54" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="144" cy="168" r="31" fill="#A991FF"/>
  <circle cx="256" cy="344" r="31" fill="#7357FF"/>
  <circle cx="368" cy="168" r="31" fill="#32D8A0"/>
`;

function iconSvg({ maskable = false } = {}) {
  const inset = maskable ? 76 : 24;
  const scale = maskable ? 0.72 : 0.9;
  const translate = 256 * (1 - scale);
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
      <defs>
        <linearGradient id="mark" x1="170" y1="160" x2="458" y2="350" gradientUnits="userSpaceOnUse">
          <stop stop-color="#A991FF"/>
          <stop offset=".5" stop-color="#7357FF"/>
          <stop offset="1" stop-color="#32D8A0"/>
        </linearGradient>
        <radialGradient id="surface" cx="0" cy="0" r="1" gradientTransform="translate(180 120) rotate(48) scale(500)">
          <stop stop-color="#171B25"/>
          <stop offset="1" stop-color="#080A0E"/>
        </radialGradient>
      </defs>
      <rect width="512" height="512" rx="${maskable ? 0 : 112}" fill="url(#surface)"/>
      <rect x="${inset}" y="${inset}" width="${512 - inset * 2}" height="${512 - inset * 2}" rx="${maskable ? 82 : 76}" fill="none" stroke="#FFFFFF" stroke-opacity=".07" stroke-width="4"/>
      <g transform="translate(${translate} ${translate}) scale(${scale})">${mark}</g>
    </svg>
  `);
}

function socialSvg() {
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
      <defs>
        <linearGradient id="mark" x1="170" y1="160" x2="458" y2="350" gradientUnits="userSpaceOnUse">
          <stop stop-color="#A991FF"/>
          <stop offset=".5" stop-color="#7357FF"/>
          <stop offset="1" stop-color="#32D8A0"/>
        </linearGradient>
        <radialGradient id="glow" cx="0" cy="0" r="1" gradientTransform="translate(1030 40) rotate(132) scale(760 630)">
          <stop stop-color="#7357FF" stop-opacity=".25"/>
          <stop offset=".55" stop-color="#32D8A0" stop-opacity=".06"/>
          <stop offset="1" stop-color="#080A0E" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="rule" x1="86" y1="0" x2="1114" y2="0" gradientUnits="userSpaceOnUse">
          <stop stop-color="#7357FF"/>
          <stop offset=".5" stop-color="#32D8A0"/>
          <stop offset="1" stop-color="#32D8A0" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="630" fill="#080A0E"/>
      <rect width="1200" height="630" fill="url(#glow)"/>
      <path d="M0 104H1200M0 526H1200M86 0V630M1114 0V630" stroke="#FFFFFF" stroke-opacity=".055"/>
      <path d="M0 315H1200" stroke="#FFFFFF" stroke-opacity=".025"/>
      <g transform="translate(20 28) scale(.34)">${mark}</g>
      <text x="188" y="135" fill="#F4F5F7" font-family="Arial, Helvetica, sans-serif" font-size="39" font-weight="700" letter-spacing="-1.1">NexusTrade</text>
      <text x="89" y="286" fill="#F7F8FA" font-family="Arial, Helvetica, sans-serif" font-size="66" font-weight="700" letter-spacing="-2.4">Trading, under control.</text>
      <text x="91" y="349" fill="#9CA3AF" font-family="Arial, Helvetica, sans-serif" font-size="25" font-weight="400">Bybit execution, TradingView automation, and live risk controls.</text>
      <rect x="89" y="411" width="1025" height="2" fill="url(#rule)"/>
      <text x="91" y="472" fill="#A991FF" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700" letter-spacing="2.4">BYBIT EXECUTION</text>
      <circle cx="298" cy="466" r="3" fill="#4B5563"/>
      <text x="324" y="472" fill="#32D8A0" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700" letter-spacing="2.4">SIGNED WEBHOOKS</text>
      <circle cx="545" cy="466" r="3" fill="#4B5563"/>
      <text x="571" y="472" fill="#CBD5E1" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700" letter-spacing="2.4">REAL-TIME RISK</text>
      <text x="1114" y="568" text-anchor="end" fill="#69717E" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="600" letter-spacing="1.8">COMMAND CENTER</text>
    </svg>
  `);
}

async function png(svg, size, output) {
  await sharp(svg).resize(size, size).png({ compressionLevel: 9 }).toFile(path.join(publicDir, output));
}

function makeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(images.length * 16);
  let offset = 6 + entries.length;
  images.forEach(({ size, data }, index) => {
    const at = index * 16;
    entries.writeUInt8(size === 256 ? 0 : size, at);
    entries.writeUInt8(size === 256 ? 0 : size, at + 1);
    entries.writeUInt8(0, at + 2);
    entries.writeUInt8(0, at + 3);
    entries.writeUInt16LE(1, at + 4);
    entries.writeUInt16LE(32, at + 6);
    entries.writeUInt32LE(data.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, entries, ...images.map(({ data }) => data)]);
}

fs.mkdirSync(publicDir, { recursive: true });

const baseIcon = iconSvg();
await Promise.all([
  png(baseIcon, 16, 'favicon-16x16.png'),
  png(baseIcon, 32, 'favicon-32x32.png'),
  png(baseIcon, 64, 'favicon.png'),
  png(baseIcon, 180, 'apple-touch-icon.png'),
  png(baseIcon, 192, 'icon-192.png'),
  png(baseIcon, 512, 'icon-512.png'),
  png(iconSvg({ maskable: true }), 512, 'icon-maskable-512.png'),
  sharp(socialSvg()).png({ compressionLevel: 9 }).toFile(path.join(publicDir, 'opengraph-image.png')),
]);

const icoImages = await Promise.all([16, 32, 48].map(async (size) => ({
  size,
  data: await sharp(baseIcon).resize(size, size).png({ compressionLevel: 9 }).toBuffer(),
})));
fs.writeFileSync(path.join(publicDir, 'favicon.ico'), makeIco(icoImages));

console.log('[brand-assets] generated favicon, app icon, Apple icon, maskable icon, and Open Graph image set');
