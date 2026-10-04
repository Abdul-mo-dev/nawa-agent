import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = join(root, 'packages')
const sourceFiles = []

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      collect(path)
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      sourceFiles.push(path)
    }
  }
}

for (const pkg of readdirSync(packagesRoot, { withFileTypes: true })) {
  if (pkg.isDirectory()) collect(join(packagesRoot, pkg.name, 'src'))
}

const appPackages = new Set([
  'browser',
  'docs',
  'html',
  'markdown',
  'pdf',
  'sheets',
  'shell',
  'slides',
])
const violations = []

for (const file of sourceFiles) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)

  function check(specifier, node) {
    if (!specifier) return
    const workspaceName = /^@genoffice\/([^/]+)/.exec(specifier)?.[1]
    const appPackage = workspaceName && appPackages.has(workspaceName)
    const target = specifier.startsWith('.') ? resolve(dirname(file), specifier) : null
    const parts = target ? relative(root, target).split(sep) : []
    const appMain = parts[0] === 'apps' && parts[2] === 'src' && parts[3] === 'main'
    if (appPackage || appMain) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      violations.push(`${relative(root, file)}:${line}: ${specifier}`)
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        check(node.moduleSpecifier.text, node)
      }
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      check(node.arguments[0].text, node)
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
}

if (violations.length) {
  console.error('Shared packages must not import app main-process code or app workspaces:')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exitCode = 1
} else {
  console.log(`Workspace boundaries passed (${sourceFiles.length} package source files).`)
}
