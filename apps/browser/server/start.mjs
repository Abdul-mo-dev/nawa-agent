// Dependency-free source-editor mode. The full suite uses src/main/index.ts.
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createBrowserServer } from './http-server.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const stateDir = path.resolve(
  arg('--state-dir') ??
    process.env.GENOFFICE_BROWSER_STATE ??
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
      'GenOfficeBrowser',
    ),
)
const port = Number(arg('--port') ?? process.env.GENOFFICE_BROWSER_PORT ?? 3210)
let service
try {
  service = await createBrowserServer({
    stateDir,
    publicDir: path.join(root, 'public'),
    editorsDir: path.join(root, 'out', 'editors'),
    port,
  })
  if (arg('--mount')) await service.workspace.mount(path.resolve(arg('--mount')))
  console.log('\nNawa source-editor service (native office editors are not loaded).')
  console.log(`Open this URL in your browser:\n${service.launchUrl}\n`)
  console.log('Press Ctrl+C to stop. Keep this console open while editing.')
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void service.close().then(() => process.exit())
    })
} catch (error) {
  console.error(
    error.code === 'EADDRINUSE'
      ? `Port ${port} is busy. Use --port with another number or close the other Nawa service.`
      : error,
  )
  await service?.close()
  process.exitCode = 1
}
