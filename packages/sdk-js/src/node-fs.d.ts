// Only the fs surface used by the adapter; typechecking needs no @types/node install.
declare module 'node:fs' {
  export const promises: {
    readFile(path: string, encoding: 'utf8'): Promise<string>
    writeFile(path: string, data: string, options: { encoding: 'utf8'; mode: number; flag: 'wx' }): Promise<void>
    rename(from: string, to: string): Promise<void>
    unlink(path: string): Promise<void>
  }
}
