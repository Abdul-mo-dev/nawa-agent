import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('packaged CLI shell launcher', () => {
  for (const [layout, appRelative] of [
    ['Nawa.app/Contents/Resources/cli', 'Nawa.app/Contents/MacOS/Nawa'],
    ['Nawa/resources/cli', 'Nawa/nawa'],
    ['Nawa Windows/resources/cli', 'Nawa Windows/Nawa.exe'],
    ['GenOffice.app/Contents/Resources/cli', 'GenOffice.app/Contents/MacOS/GenOffice'],
    ['GenOffice/resources/cli', 'GenOffice/genoffice'],
  ] as const) {
    it(`uses the bundled runtime at ${appRelative} with argument and exit-code preservation`, () => {
      const root = mkdtempSync(join(tmpdir(), 'nawa launcher '))
      dirs.push(root)
      const cliDir = join(root, layout)
      const app = join(root, appRelative)
      mkdirSync(cliDir, { recursive: true })
      mkdirSync(dirname(app), { recursive: true })
      const launcher = join(cliDir, 'genoffice')
      copyFileSync(fileURLToPath(new URL('../bin/genoffice', import.meta.url)), launcher)
      chmodSync(launcher, 0o755)
      writeFileSync(join(cliDir, 'genoffice.cjs'), '')
      writeFileSync(
        app,
        '#!/bin/sh\nprintf "runtime=%s\\n" "$ELECTRON_RUN_AS_NODE"\nprintf "arg=%s\\n" "$@"\nexit 17\n',
      )
      chmodSync(app, 0o755)
      const args = ['mcp', 'a document with spaces', 'literal $(not-a-command)']
      const result = spawnSync(launcher, args, {
        env: { ...process.env, GENOFFICE_NODE: undefined },
        encoding: 'utf8',
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(17)
      expect(result.stdout.trim().split('\n')).toEqual([
        'runtime=1',
        `arg=${join(cliDir, 'genoffice.cjs')}`,
        ...args.map((arg) => `arg=${arg}`),
      ])
    })
  }
})
