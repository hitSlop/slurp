// Vite's `?raw` imports (the fixtures are read as text; workerd has no file system).
declare module '*?raw' {
  const text: string
  export default text
}
