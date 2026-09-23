import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, relative, join } from 'node:path'

const root = process.env.GITHUB_WORKSPACE || process.cwd()
const directory = join(root, 'wework')
const require = createRequire(join(directory, 'package.json'))
const paths = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACM', '-z', '01971fc01d1547adaefa7097c5741061b2a90c7b', 'HEAD', '--', 'wework'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
for (const path of paths) {
  if (!existsSync(resolve(root, path))) throw new Error(`Changed source does not exist: ${path}`)
}
process.chdir(directory)
const mode = process.argv[2]
if (mode === 'format') {
  const prettier = require('prettier')
  for (const path of paths.filter(path => /\.(tsx?|json|ya?ml|md)$/.test(path))) {
    const filepath = resolve(root, path)
    const source = readFileSync(filepath, 'utf8')
    const options = await prettier.resolveConfig(filepath)
    const formatted = await prettier.format(source, { ...options, filepath })
    if (source !== formatted) writeFileSync(filepath, formatted)
    console.log(`${path}: ${source === formatted ? 'unchanged' : 'formatted'}`)
  }
} else if (mode === 'lint') {
  const { ESLint } = require('eslint')
  const eslint = new ESLint({ cwd: directory })
  const files = paths.filter(path => /\.tsx?$/.test(path)).map(path => relative(directory, resolve(root, path)))
  const results = await eslint.lintFiles(files)
  const formatter = await eslint.loadFormatter('stylish')
  console.log(formatter.format(results))
  if (results.some(result => result.errorCount > 0 || result.fatalErrorCount > 0)) process.exitCode = 1
} else {
  throw new Error('Use format or lint')
}
