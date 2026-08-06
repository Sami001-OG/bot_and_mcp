import { readFile } from 'node:fs/promises';

const required = [
  'docs/architecture.md',
  'docs/database.md',
  'docs/er-diagram.md',
  'docs/api.md',
  'docs/websocket.md',
  'docs/deployment.md',
  'docs/security.md',
  'docs/exchange-certification.md',
  'docs/openapi.yaml',
  'docs/asyncapi.yaml',
  'docs/schema.graphql',
  'docs/architecture-overview.html'
];
for (const file of required) {
  const text = await readFile(file, 'utf8');
  if (text.length < 200) throw new Error(`${file} is incomplete`);
}
console.log(`Validated ${required.length} documentation files.`);
