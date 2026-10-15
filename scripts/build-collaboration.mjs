import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'src', 'ui', 'vendor-licenses'), { recursive: true });
for (const dependency of ['yjs', 'lib0', 'isomorphic.js']) {
  await copyFile(path.join(root, 'node_modules', dependency, 'LICENSE'), path.join(root, 'src', 'ui', 'vendor-licenses', `${dependency}.txt`));
}
await build({ entryPoints: [path.join(root, 'src', 'ui', 'collaboration-entry.mjs')], outfile: path.join(root, 'src', 'ui', 'collaboration-model.js'), bundle: true, format: 'iife', minify: true, banner: { js: '/* Yjs and dependencies: MIT licenses in vendor-licenses/. Built with npm run build:collaboration. */' } });
