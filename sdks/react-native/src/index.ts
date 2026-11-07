import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState, Platform } from 'react-native'
import { chunkedStorage } from './chunked.ts'
import { createNativeClient, type ReactNativeClient, type ReactNativeOptions } from './native.ts'

export { memoryStorage } from '@hitslop/slurp-sdk'
export type { CaptureOptions, FlushResult, SlurpClient, SlurpOptions, StorageAdapter } from '@hitslop/slurp-sdk'
export { version } from './native.ts'
export { chunkedStorage } from './chunked.ts'
export type { ApplicationLike, NetInfoLike, ReactNativeClient, ReactNativeOptions } from './native.ts'

/** Create an independent client. Most apps call `init` once instead. */
export const createClient = (options: ReactNativeOptions): ReactNativeClient =>
  createNativeClient(options, { appState: AppState, platform: Platform, storage: chunkedStorage(AsyncStorage) })

let defaultClient: ReactNativeClient | undefined
/** Create or replace the default client used by `track`, `identify`, `screen`, `flush` and `reset`. */
export function init(options: ReactNativeOptions): ReactNativeClient {
  if (defaultClient) void defaultClient.close()
  return defaultClient = createClient(options)
}
const client = (): ReactNativeClient => {
  if (!defaultClient) throw new Error('call init before using the default client')
  return defaultClient
}
export const track: ReactNativeClient['track'] = (event, data, options) => client().track(event, data, options)
export const identify: ReactNativeClient['identify'] = (userId, data) => client().identify(userId, data)
export const screen: ReactNativeClient['screen'] = (name, data) => client().screen(name, data)
export const reset = (): void => client().reset()
export const flush: ReactNativeClient['flush'] = () => client().flush()
