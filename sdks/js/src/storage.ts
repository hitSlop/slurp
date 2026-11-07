export interface StorageAdapter {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

export function memoryStorage(): StorageAdapter {
  const values = new Map<string, string>()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  }
}

export function defaultStorage(report: (error: unknown) => void): StorageAdapter {
  const memory = memoryStorage()
  if (typeof window === 'undefined') return memory
  let failed = false
  return {
    getItem(key) {
      if (!failed) {
        try { return window.localStorage.getItem(key) }
        catch (error) { failed = true; report(error) }
      }
      return memory.getItem(key)
    },
    setItem(key, value) {
      memory.setItem(key, value)
      if (!failed) {
        try { window.localStorage.setItem(key, value) }
        catch (error) { failed = true; report(error) }
      }
    },
    removeItem(key) {
      memory.removeItem(key)
      if (!failed) {
        try { window.localStorage.removeItem(key) }
        catch (error) { failed = true; report(error) }
      }
    },
  }
}
