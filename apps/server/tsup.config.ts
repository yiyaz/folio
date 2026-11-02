import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/main.ts', 'src/migrate-cli.ts', 'src/admin-cli.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // bundle the workspace markdown package, keep real npm deps external
  noExternal: [/^@folio\//],
  // bundled CommonJS dependencies of @folio/markdown call require()
  banner: { js: "import { createRequire as __folioCreateRequire } from 'node:module'; const require = __folioCreateRequire(import.meta.url);" },
});
