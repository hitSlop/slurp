// The only parts of React Native and AsyncStorage this package touches, so it type-checks without installing them.
declare module 'react-native' {
  export const AppState: { addEventListener(type: 'change', listener: (state: string) => void): { remove(): void } }
  export const Platform: { OS: string; Version: string | number; constants?: Record<string, unknown> }
}
declare module '@react-native-async-storage/async-storage' {
  const AsyncStorage: {
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
    removeItem(key: string): Promise<void>
  }
  export default AsyncStorage
}
