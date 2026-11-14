import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'styles.css', 'main.js', 'favicon.svg', 'logo.svg']) {
  await cp(new URL(file, root), new URL(file, output));
}
console.log(`Built Nierwall landing page → ${fileURLToPath(output)}`);
