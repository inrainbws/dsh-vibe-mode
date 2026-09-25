// Wrap the CommonJS client build in the module-loader envelope that
// dsh-client-modules expects (same shape as the official client bundles).
import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const dir = new URL('../lib/.client/', import.meta.url).pathname
const file = readdirSync(dir).find(name => /^client\.cjs(\.c?js)?$/.test(name))
if (file === undefined) throw new Error(`wrap-client: no client build in ${dir}`)
const body = readFileSync(join(dir, file), 'utf8').replace(/\n\/\/# sourceMappingURL=.*$/m, '')
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`
writeFileSync(new URL('../lib/client.js', import.meta.url), wrapped)
rmSync(dir, { recursive: true, force: true })
