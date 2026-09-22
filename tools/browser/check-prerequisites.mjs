import { spawnSync } from 'node:child_process'
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 12)) {
  console.error('GenOffice requires Node.js 22.12 or newer (the original project requirement).')
  process.exit(1)
}
if (process.platform !== 'win32') console.warn('This launcher targets native Windows. Core API tests are portable; Windows runtime validation is still required.')
const check = spawnSync('cargo', ['--version'], { encoding: 'utf8', shell: false })
if (check.status !== 0) {
  console.error('Spreadsheet builds require Rust (MSVC toolchain on Windows). Install Rust and the Microsoft C++ Build Tools with Desktop development with C++, then reopen your terminal. Source-only mode needs only Node.js.')
  process.exit(1)
}
console.log(`Node ${process.versions.node}; ${check.stdout.trim()}`)
