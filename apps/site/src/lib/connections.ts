export type Connection = {name:string;description:string;icon?:string;logo?:string;install?:string;status:'Available locally'|'Works today'|'Preview'|'Exploring';href?:string};
export type ConnectionGroup = {id:string;title:string;items:Connection[]};
const future=(name:string,description:string,logo?:string,icon='connections'):Connection=>({name,description,logo,icon,status:'Exploring'});
export const current:Connection[]=[
 {name:'JavaScript / TypeScript',description:'Browser and Node event capture with a durable queue.',install:'npm install @hitslop/slurp-sdk',icon:'code',status:'Works today',href:'/docs/#capture'},
 {name:'React Native / Expo',description:'Events survive the app being killed (AsyncStorage) and are sent when it goes to the background. Tested against fakes; not yet on a device.',install:'npm install @hitslop/slurp-react-native',icon:'code',status:'Preview',href:'/connections/#sdks'},
 {name:'Swift',description:'iOS, macOS, tvOS and watchOS. Events are written to disk before they are sent. Not yet run in an app on a device.',install:'Xcode: add github.com/hitSlop/slurp',icon:'code',status:'Preview',href:'/connections/#sdks'},
 {name:'Segment',description:'Keep your Segment SDK and change its host to your Worker. Verified with analytics-node, analytics-next and analytics-swift.',install:'writeKey: slurp_pk_… · host: your Worker',icon:'connections',status:'Works today',href:'/connections/#sdks'},
 {name:'Sentry',description:'Keep your Sentry SDK and change the DSN. Errors are stored whole and read with SQL. No symbolication or issue UI. Verified with @sentry/node and @sentry/browser.',install:'dsn: https://HEX_KEY@your-worker/1',logo:'sentry',status:'Works today',href:'/connections/#sdks'},
 {name:'HTTP API',description:'Send canonical events as NDJSON to your configured backend.',icon:'globe',status:'Works today',href:'/docs/#http'},
 ...['Claude Code','Codex','Cursor'].map((name,i):Connection=>({name,description:'Run the Slurp CLI and query your local DuckDB data.',logo:['claude','codex','cursor'][i],status:'Works today',href:'/docs/#agent'}))
];
export const groups:ConnectionGroup[]=[
 {id:'capture',title:'More ways to capture',items:[future('Rust','A dedicated capture SDK.'),future('Python','Capture from Python applications.'),future('Kotlin (Android)','A native Android SDK. Segment and Sentry Android SDKs may already work by changing the URL, but are untested.'),future('File uploads','Bring CSV, Parquet, JSONL, and logs.',undefined,'file')]},
 {id:'analytics',title:'Product analytics inputs',items:['Mixpanel','Amplitude','RudderStack'].map(n=>future(n,'Bring existing product events into Slurp.'))},
 {id:'errors',title:'Errors and support inputs',items:[future('Sentry symbolication','Readable stack traces from your own source maps and debug files.','sentry'),future('Bugsnag','Errors and stability.'),future('Customer chat','Support conversations and transcripts.'),future('Bug reports','Feedback directly from users.')]},
 {id:'business',title:'Business and code inputs',items:[future('Stripe','Payments and subscriptions.','stripe'),future('GitHub','Pushes, pull requests, and releases.','github'),future('Linear','Issues and cycles.','linear')]},
 {id:'pipelines',title:'Pipeline inputs',items:[future('Webhooks','Translate incoming tool payloads into events.',undefined,'webhook'),future('Kafka','Receive events from your pipelines.')]},
 {id:'outputs',title:'Outputs and agent destinations',items:[future('Webhooks','Deliver events to your own endpoint.',undefined,'webhook'),future('Slack','Alerts in a channel.','slack'),future('Linear','Create an issue from a finding.','linear'),future('GitHub','Open an issue or pull request.','github'),...['Muse','Grok','OpenAI','dots','Custom agents'].map(n=>future(n,'Route relevant events to an agent.'))]}
];
