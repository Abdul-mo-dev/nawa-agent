#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const result = spawnSync(process.execPath, [
  '--experimental-transform-types', '--test', fileURLToPath(new URL('./workspace.test.mjs', import.meta.url)),
], { stdio: 'inherit' })
if (result.error) { console.error(result.error.message); process.exitCode = 1 }
else process.exitCode = result.status ?? 1
