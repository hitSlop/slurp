import { chunkedStorage } from '../src/chunked.ts'
import { createNativeClient } from '../src/native.ts'
import type { NativeEnvironment } from '../src/native.ts'
import { runConformance } from '../../js/test/conformance-runner.ts'

// The shared delivery scenarios (sdks/conformance/delivery.json) through the React Native client, with its queue stored the way the
// default storage does it: in pieces, on an AsyncStorage that refuses any single value above a limit (as Android does).
const env = (storage: NativeEnvironment['storage']): NativeEnvironment => ({
  appState: { addEventListener: () => ({ remove: () => {} }) },
  platform: { OS: 'ios', Version: '18.1' },
  storage,
})

runConformance({
  name: 'react-native',
  create: options => createNativeClient(options, env(options.storage!)),
  storage: base => chunkedStorage({
    getItem: async key => { const value = await base.getItem(key); if (value !== null && value.length > 1000) throw new Error('Row too big to fit into CursorWindow'); return value },
    setItem: async (key, value) => { if (value.length > 1000) throw new Error('value too large'); await base.setItem(key, value) },
    removeItem: key => base.removeItem(key),
  }, 512),
})
