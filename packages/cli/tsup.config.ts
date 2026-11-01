import { defineConfig } from 'tsup';
export default defineConfig({ entry: { folio: 'src/folio.ts' }, format: ['esm'], target: 'node22', clean: true, banner: { js: '#!/usr/bin/env node' } });
