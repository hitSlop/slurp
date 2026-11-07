# SDKs

Libraries that send events to your Slurp Worker. All of them write the same record (see the [event format](../docs/architecture.md)) and share the same delivery rules: a durable queue, batching, byte-identical retries so a retry never double counts, and no truncation.

| SDK | Package | Status |
| --- | --- | --- |
| [JavaScript and TypeScript](js) | `@hitslop/slurp-sdk` on npm | Published. Browser and Node |
| [React Native and Expo](react-native) | `@hitslop/slurp-react-native` on npm | Written and tested against fakes; not yet run on a device |
| [Swift](swift) | Swift package at the repository root: `https://github.com/hitSlop/slurp` | Planned |

Already using Segment or Sentry? You do not need an SDK: point their SDK at your Worker. See [Connections and compatibility](../docs/sdks.md).
