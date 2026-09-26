/** Vite imports the worker as text; no ASAR path or secondary worker bundle is needed. */
declare module '*.cjs?raw' {
  const source: string
  export default source
}
