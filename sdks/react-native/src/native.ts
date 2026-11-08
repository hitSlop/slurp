import {
  createClient as createCoreClient,
  type CaptureOptions, type FlushResult, type SlurpClient, type SlurpOptions, type StorageAdapter,
} from '@hitslop/slurp-sdk'

export const version = '0.2.0'

/** The slice of React Native's AppState that is used. */
export interface AppStateLike {
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void }
}
/** The slice of React Native's Platform that is used. */
export interface PlatformLike { OS: string; Version: string | number; constants?: Record<string, unknown> }
/** `@react-native-community/netinfo`'s default export. */
export interface NetInfoLike {
  addEventListener(listener: (state: { isConnected: boolean | null; isInternetReachable?: boolean | null }) => void): () => void
}
/** `expo-application`'s namespace (or any object with the same fields). */
export interface ApplicationLike { nativeApplicationVersion?: string | null; nativeBuildVersion?: string | null; applicationId?: string | null }

/** What the package takes from React Native itself; tests supply fakes. */
export interface NativeEnvironment { appState: AppStateLike; platform: PlatformLike; storage: StorageAdapter }

export interface ReactNativeOptions extends Omit<SlurpOptions, 'storage' | 'flushOnHide'> {
  /** Where the queue and visitor identity live between launches. Defaults to AsyncStorage (split into small pieces, see `chunkedStorage`), so events survive the app being closed or killed. */
  storage?: StorageAdapter
  /** Optional `@react-native-community/netinfo`: send what is queued as soon as the connection returns. */
  netInfo?: NetInfoLike
  /** Optional `expo-application`: adds the app version, build number and bundle id to every event. */
  application?: ApplicationLike
  appVersion?: string
  appBuild?: string
}

export interface ReactNativeClient extends SlurpClient {
  /** Record that a screen was shown: an event named `screen` with `{ name, ...data }`. Later events carry `context.screen`. Works with any navigation library. */
  screen(name: string, data?: Record<string, unknown>): string
}

const clean = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ''))

function localeAndZone(): { locale?: string; timezone?: string } {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions()
    return { locale: resolved.locale, timezone: resolved.timeZone }
  } catch { return {} }
}

/** A client with React Native defaults: durable storage, device context, flush when the app leaves the foreground, flush when the network returns. */
export function createNativeClient(options: ReactNativeOptions, env: NativeEnvironment): ReactNativeClient {
  const { storage, netInfo, application, appVersion, appBuild, context: userContext, ...rest } = options
  const { platform } = env
  let currentScreen: string | undefined
  const automatic = (): Record<string, unknown> => {
    const { locale, timezone } = localeAndZone()
    return clean({
      library: { name: '@hitslop/slurp-react-native', version },
      os: clean({ name: platform.OS, version: String(platform.Version) }),
      app: clean({ version: appVersion ?? application?.nativeApplicationVersion ?? undefined, build: appBuild ?? application?.nativeBuildVersion ?? undefined, id: application?.applicationId ?? undefined }),
      device: clean({ model: (platform.constants?.Model ?? platform.constants?.model) as string | undefined }),
      locale, timezone,
      screen: currentScreen,
    })
  }
  const core = createCoreClient({
    // AsyncStorage holds about 6 MB in total on Android and is shared with the app, so keep less queued than the web default.
    maxQueueBytes: 2 * 1024 * 1024,
    ...rest,
    storage: storage ?? env.storage,
    flushOnHide: false,
    context: () => ({ ...automatic(), ...(typeof userContext === 'function' ? userContext() : userContext ?? {}) }),
  })
  // The OS may suspend the app right after it leaves the foreground, so send then; also catch up when it returns.
  const subscription = env.appState.addEventListener('change', state => { if (state === 'background' || state === 'inactive' || state === 'active') void core.flush() })
  const unsubscribeNet = netInfo?.addEventListener(state => { if (state.isConnected && state.isInternetReachable !== false) void core.flush() })
  let closed = false
  return {
    track: (event, data, overrides?: CaptureOptions) => core.track(event, data, overrides),
    identify: (userId, data) => core.identify(userId, data),
    screen(name, data = {}) {
      currentScreen = name
      return core.track('screen', { name, ...data })
    },
    reset: () => core.reset(),
    flush: (): Promise<FlushResult> => core.flush(),
    close() {
      if (!closed) { closed = true; subscription.remove(); unsubscribeNet?.() }
      return core.close()
    },
    get pending() { return core.pending },
  }
}
