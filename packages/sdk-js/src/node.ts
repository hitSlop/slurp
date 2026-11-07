import { promises as fs } from 'node:fs'
import type { StorageAdapter } from './storage.ts'

export function fileStorage(path: string): StorageAdapter {
  let operations = Promise.resolve()
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operations.then(operation)
    operations = result.then(() => {}, () => {})
    return result
  }
  const read = async (): Promise<Record<string, string>> => {
    try { return JSON.parse(await fs.readFile(path, 'utf8')) }
    catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return Object.create(null)
      throw error
    }
  }
  const write = async (values: Record<string, string>) => {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(values), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await fs.rename(temporary, path)
    } finally {
      await fs.unlink(temporary).catch(error => {
        if ((error as { code?: string }).code !== 'ENOENT') throw error
      })
    }
  }
  return {
    getItem: key => run(async () => (await read())[key] ?? null),
    setItem: (key, value) => run(async () => { const values = await read(); values[key] = value; await write(values) }),
    removeItem: key => run(async () => { const values = await read(); delete values[key]; await write(values) }),
  }
}
