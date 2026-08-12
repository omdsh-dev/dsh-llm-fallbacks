/**
 * Parse-only guard for dist artifacts — never executes module code, never
 * resolves imports. Catches the boot failure mode where the bundler leaves
 * standard-decorator syntax (e.g. `@Remote(...)`) verbatim in emitted ESM,
 * which Node cannot parse.
 *
 * - host bundle: `dist/index.js` is ESM -> `node --check --input-type=module`
 *   (syntax check only, no execution, no dependency resolution). The original
 *   design called for `new vm.SourceTextModule(...)`, but Node 24 removed the
 *   experimental `vm.Module` API; `--check --input-type=module` is Node's
 *   built-in parse-only ESM path and matches the old guard's semantics.
 * - client bundle: `dist/client/index.js` is a CJS closure -> `vm.Script`
 *   (classic-script compile at construction).
 *
 * On SyntaxError, prints file + message and exits 1; otherwise prints sizes
 * and exits 0.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const targets = [
  { name: 'host', file: 'dist/index.js', kind: 'esm' },
  { name: 'client', file: 'dist/client/index.js', kind: 'cjs' },
]

let failed = false
for (const { name, file, kind } of targets) {
  const code = readFileSync(file, 'utf8')
  const bytes = Buffer.byteLength(code)
  const lines = code.split('\n').length
  let error = null
  if (kind === 'esm') {
    const result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
      input: code,
      encoding: 'utf8',
    })
    if (result.status !== 0) {
      error = new SyntaxError(
        (result.stderr.split('\n').find(line => line.startsWith('SyntaxError')) ??
          result.stderr.trim() ??
          result.error?.message ??
          'syntax check failed'),
      )
    }
  } else {
    try {
      new Script(code)
    } catch (cause) {
      error = cause
    }
  }
  if (error === null) {
    console.log(`verify-dist: ${name} OK (${file}, ${bytes} bytes, ${lines} lines)`)
  } else {
    failed = true
    if (error instanceof SyntaxError) {
      console.error(`verify-dist: ${name} SyntaxError in ${file}: ${error.message}`)
    } else {
      throw error
    }
  }
}

if (failed) {
  console.error('verify-dist: dist parse check failed')
  process.exit(1)
}
