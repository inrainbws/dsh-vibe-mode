import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    // Host half: an ES module the dsh Loader imports by package name.
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: { sourcemap: false },
    clean: false,
    external: [/^@deepseek-ai\//, 'zod'],
  },
  {
    // Browser half: CommonJS body that scripts/wrap-client.mjs wraps in the
    // `window.__ModuleLoader__.load` envelope dsh-client-modules serves.
    entry: { 'client.cjs': 'src/client.tsx' },
    outDir: 'lib/.client',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: true,
    external: ['react', 'react/jsx-runtime', /^@deepseek-ai\//],
  },
])
