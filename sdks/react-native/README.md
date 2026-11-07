# @hitslop/slurp-react-native

React Native and Expo event capture for [Slurp](https://slurp.run). Events go to the Worker in your own Cloudflare account; `slurp sync` pulls them into DuckDB for your coding agent. It is a thin layer over [`@hitslop/slurp-sdk`](../js) that adds what a mobile app needs: a queue that survives the app being killed, a flush when the app goes to the background, and device context.

```sh
npm install @hitslop/slurp-react-native @react-native-async-storage/async-storage
```

`slurp init` prints your ingest URL, source ID and publishable key (`slurp_pk_…`, ingest-only, safe to ship in an app).

```ts
import { init, track, identify, screen } from '@hitslop/slurp-react-native';

init({
  key: 'slurp_pk_…',
  sourceId: 'src_…',
  endpoint: 'https://slurp.YOUR-SUBDOMAIN.workers.dev/v1/events',
});

screen('Home');
track('purchase_completed', { total: 49 });
identify('user-42', { plan: 'pro' });
```

## Events survive the app being closed

Every event is written to AsyncStorage (the default; pass `storage` to use something else) before anything is sent. A batch is frozen to storage before its first send attempt, and is removed only after the Worker acknowledges it, so a kill, a crash or a dead network never loses an acknowledged-pending event and a retry resends the identical bytes (the Worker drops a duplicate it already stored). The visitor identity, signed-in user and session survive relaunches too.

Queued events are sent:

- when the queue reaches `flushAt` (100) events or every `flushIntervalMs` (5 s) while the app is open;
- when the app goes to the `background` or `inactive` state (the OS may suspend the app right after, so this is when it sends);
- when the app returns to `active`;
- when the network comes back, if you pass NetInfo.

Failures back off with jitter and honor `Retry-After`, including across relaunches. Events are never truncated; one larger than 1 MiB is dropped and reported through `onError`.

## Options

Everything in the [core SDK options](../js#readme) works (`flushAt`, `maxQueue`, `onError`, `context`, ...), plus:

| Option | Meaning |
| --- | --- |
| `storage` | Defaults to AsyncStorage. Any `{getItem, setItem, removeItem}` object, sync or async |
| `netInfo` | `@react-native-community/netinfo`'s default export: flush as soon as the connection returns |
| `application` | `expo-application`'s namespace: adds the app version, build number and bundle id to every event |
| `appVersion`, `appBuild` | Set these yourself instead of using `expo-application` |

```ts
import NetInfo from '@react-native-community/netinfo';
import * as Application from 'expo-application';

init({ key, sourceId, endpoint, netInfo: NetInfo, application: Application });
```

Every event carries `context.os` (`{name, version}`), `context.app`, `context.device.model` when the platform reports one, `context.locale`, `context.timezone` and `context.screen` (the last `screen()` name). `screen(name, data)` records an event named `screen` with `{name, ...data}`; call it from your navigation library's state-change callback.

`track`, `identify`, `screen`, `flush` and `reset` use the client from `init`. `createClient(options)` returns an independent client with the same methods plus `close()`, which removes its listeners.

## Notes and limits

- It has no native modules: it uses React Native's `AppState` and `Platform`, AsyncStorage, and optional NetInfo and expo-application. It works in Expo and bare projects. `react-native` and `@react-native-async-storage/async-storage` are peer dependencies; install them in your app.
- Hermes ships `TextEncoder` from React Native 0.74; older versions use a built-in fallback. Ids use `crypto.getRandomValues` when present and `Math.random` otherwise (they only need to be unique).
- What was tested: the queue, relaunch recovery, lifecycle and context logic run in Node against fakes of `AppState`, `Platform`, AsyncStorage and NetInfo, and the core runs against a real Worker. It has not yet been run on a device or simulator.

## License

MIT
