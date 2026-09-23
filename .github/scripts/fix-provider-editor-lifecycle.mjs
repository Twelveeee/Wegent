import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(resolve('wework/package.json'))
const ts = require('typescript')
const path = 'wework/src/components/settings/ProviderSettingsSection.tsx'
const text = readFileSync(path, 'utf8')
assert(text.includes('providerModelConfiguration'), 'Expected integrated provider editor')
assert(!text.includes('providerConfigClient'), 'Refusing an inactive alternate implementation')
const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const edits = []
let resetCount = 0
let selectionEffect = false
let selectedBinding = null

function walk(node) {
  if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)) {
    const [value, setter] = node.name.elements
    if (value?.name?.getText(source) === 'selectedId' && setter?.name?.getText(source) === 'setSelectedId') {
      selectedBinding = node
    }
  }
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'useEffect') {
    const [callback, dependencies] = node.expression.arguments
    if (callback && dependencies && ts.isArrowFunction(callback) && ts.isArrayLiteralExpression(dependencies)) {
      const deps = dependencies.elements.map(item => item.getText(source))
      const body = callback.body.getText(source)
      if (deps.includes('selectedId') && deps.includes('snapshot') && body.includes('setSelectedId(')) {
        assert(!selectionEffect, 'Unexpected duplicate selection effect')
        selectionEffect = true
        edits.push({ start: node.getStart(source), end: node.end, value: '\n' })
      } else if (deps.length === 1 && /\bset(?:Form|State|Name|Enabled)\(/.test(body)) {
        const dependency = deps[0]
        assert(['provider', 'initial', 'model'].includes(dependency), 'Unexpected form reset dependency')
        assert(!body.includes('await ') && !body.includes('return '), 'Unexpected reset side effects')
        const suffix = ++resetCount
        const previous = `previousEditorInput${suffix}`
        const setter = `setPreviousEditorInput${suffix}`
        const statements = ts.isBlock(callback.body) ? body.slice(1, -1) : body
        edits.push({
          start: node.getStart(source), end: node.end,
          value: `// Adjust only this component's draft before committing stale input to the DOM.\nconst [${previous}, ${setter}] = useState(${dependency})\nif (${previous} !== ${dependency}) {\n${setter}(${dependency})\n${statements}\n}\n`,
        })
      }
    }
  }
  ts.forEachChild(node, walk)
}
walk(source)
if (selectionEffect) {
  assert(selectedBinding, 'Selection effect has no matching state declaration')
  const binding = selectedBinding.name.elements[0].name
  edits.push({ start: binding.getStart(source), end: binding.end, value: 'requestedSelectedId' })
  const statement = selectedBinding.parent.parent
  assert(ts.isVariableStatement(statement), 'Unexpected selection declaration')
  edits.push({ start: statement.end, end: statement.end,
    value: `\nconst selectedId = snapshot?.providers.some(row => row.id === requestedSelectedId)\n  ? requestedSelectedId\n  : (snapshot?.providers[0]?.id ?? '')\n` })
}
let result = text
for (const edit of edits.sort((a, b) => b.start - a.start)) {
  result = result.slice(0, edit.start) + edit.value + result.slice(edit.end)
}
const checked = ts.createSourceFile(path, result, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
assert.equal(checked.parseDiagnostics.length, 0, 'Provider editor transformation must remain syntactically valid')
writeFileSync(path, result)
console.log(`Provider editor lifecycle: ${resetCount} guarded draft resets; derived selection ${selectionEffect ? 'updated' : 'already independent of effects'}`)

const storePath = 'wework/electron/src/host/model-configuration-store.ts'
const storeSource = readFileSync(storePath, 'utf8')
const symptom = "new Error('model.yml is missing; restore it before opening')"
writeFileSync(storePath, storeSource.replace(symptom, "new Error('model.yml is missing; restore it before opening', { cause: error })"))
