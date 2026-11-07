export type Connection = {name:string;description:string;icon?:string;logo?:string;install?:string;status:'Available locally'|'Works today'|'Preview'|'Exploring';href?:string};
export type ConnectionGroup = {id:string;title:string;items:Connection[]};
const future=(name:string,description:string,logo?:string,icon='connections'):Connection=>({name,description,logo,icon,status:'Exploring'});
export const current:Connection[]=[
 {name:'JavaScript / TypeScript',logo:'javascript',description:'Browser and Node event capture with a durable queue.',install:'npm install @hitslop/slurp-sdk',status:'Works today',href:'/docs/#capture'},
 {name:'React Native / Expo',logo:'reactnative',description:'Events survive the app being killed (AsyncStorage) and are sent when it goes to the background. Tested against fakes; not yet on a device.',install:'npm install @hitslop/slurp-react-native',status:'Preview',href:'/connections/#sdks'},
 {name:'Swift',logo:'swift',description:'iOS, macOS, tvOS and watchOS. Events are written to disk before they are sent. Not yet run in an app on a device.',install:'Xcode: add github.com/hitSlop/slurp',status:'Preview',href:'/connections/#sdks'},
 {name:'Segment',logo:'segment',description:'Keep your Segment SDK and change its host to your Worker. Verified with analytics-node, analytics-next and analytics-swift.',install:'writeKey: slurp_pk_… · host: your Worker',status:'Works today',href:'/connections/#sdks'},
 {name:'Sentry',description:'Keep your Sentry SDK and change the DSN. Errors are stored whole and read with SQL. No symbolication or issue UI. Verified with @sentry/node and @sentry/browser.',install:'dsn: https://slurp_pk_…@your-worker/1',logo:'sentry',status:'Works today',href:'/connections/#sdks'},
 {name:'MCP',description:'Let Claude Code, Cursor, Codex, Claude Desktop or Windsurf read your events: describe the schema, run read-only SQL in a sandbox, sync and build reports. Verified with the official MCP Inspector client.',install:'claude mcp add slurp -- slurp mcp',icon:'agent',status:'Works today',href:'/docs/#agent'},
 {name:'Slack',description:'Post a report image and a summary to a channel: slurp notify slack, for scheduled reports. Tested against a fake Slack API, not yet a real workspace.',install:'slurp notify slack --file report.png',logo:'slack',status:'Preview',href:'/docs/#agent'},
 {name:'Discord',description:'The same from the command line with a Discord webhook, image included. Tested against a fake Discord server.',install:'slurp notify discord --file report.png',icon:'webhook',status:'Preview',href:'/docs/#agent'},
 {name:'GitHub',description:'Releases, deployments and workflow runs arrive as events, signed and stored whole, with a releases view in SQL. Tested against GitHub\'s documented signature example, not yet a live delivery.',install:'slurp project webhook PROJECT github',logo:'github',status:'Preview',href:'/docs/#webhooks'},
 {name:'Stripe',description:'Payments and subscriptions arrive as signed events. Tested against Stripe\'s documented signature scheme, not yet a live delivery.',install:'slurp project webhook PROJECT stripe --secret whsec_…',logo:'stripe',status:'Preview',href:'/docs/#webhooks'},
 {name:'Webhooks',description:'Any tool that can POST: the payload is stored whole as an event, named by you, optionally signed.',install:'slurp project webhook PROJECT generic',icon:'webhook',status:'Preview',href:'/docs/#webhooks'},
 {name:'HTTP API',description:'Send canonical events as NDJSON to your configured backend.',icon:'globe',status:'Works today',href:'/docs/#http'},
 ...['Claude Code','Codex','Cursor'].map((name,i):Connection=>({name,description:'Run the Slurp CLI and query your local DuckDB data.',logo:['claude','codex','cursor'][i],status:'Works today',href:'/docs/#agent'}))
];
export const groups:ConnectionGroup[]=[
 {id:'capture',title:'More ways to capture',items:[future('Rust','A dedicated capture SDK.','rust'),future('Python','Capture from Python applications.','python'),future('Kotlin (Android)','A native Android SDK. Segment and Sentry Android SDKs may already work by changing the URL, but are untested.','kotlin'),future('File uploads','Bring CSV, Parquet, JSONL, and logs.',undefined,'file')]},
 {id:'analytics',title:'Product analytics inputs',items:['Mixpanel','Amplitude','RudderStack'].map(n=>future(n,'Bring existing product events into Slurp.'))},
 {id:'errors',title:'Errors and support inputs',items:[future('Sentry symbolication','Readable stack traces from your own source maps and debug files.','sentry'),future('Bugsnag','Errors and stability.'),future('Customer chat','Support conversations and transcripts.'),future('Bug reports','Feedback directly from users.')]},
 {id:'business',title:'Business and code inputs',items:[future('Linear','Issues and cycles. Its webhooks can use the generic receiver today, but are untested.','linear')]},
 {id:'pipelines',title:'Pipeline inputs',items:[future('Kafka','Receive events from your pipelines.')]},
 {id:'outputs',title:'Outputs and agent destinations',items:[future('Webhooks','Deliver events to your own endpoint.',undefined,'webhook'),future('Linear','Create an issue from a finding.','linear'),future('GitHub','Open an issue or pull request.','github'),...['Muse','Grok','OpenAI','dots','Custom agents'].map(n=>future(n,'Route relevant events to an agent.'))]}
];

/** The tools Slurp works with, for the badge row on the site and the generated README badges (apps/site/scripts/readme-badges.mjs).
 *  `slug` is a Simple Icons name shields.io knows; entries without one use the SVG in packages/web-shared/logos. */
export type WorksWith={name:string;note:string;group:'capture'|'keep'|'soon';logo?:string;icon?:string;slug?:string;color:string;logoColor?:string};
export const worksWith:WorksWith[]=[
 {name:'JavaScript',note:'SDK',group:'capture',logo:'javascript',slug:'javascript',color:'F7DF1E',logoColor:'white'},
 {name:'TypeScript',note:'types included',group:'capture',logo:'typescript',slug:'typescript',color:'3178C6',logoColor:'white'},
 {name:'Web',note:'browser SDK',group:'capture',icon:'globe',slug:'googlechrome',color:'4285F4',logoColor:'white'},
 {name:'Node.js',note:'SDK',group:'capture',logo:'nodejs',slug:'nodedotjs',color:'5FA04E',logoColor:'white'},
 {name:'React Native',note:'preview SDK',group:'capture',logo:'reactnative',color:'61DAFB'},
 {name:'Swift',note:'preview SDK',group:'capture',logo:'swift',slug:'swift',color:'F05138',logoColor:'white'},
 {name:'HTTP API',note:'any language',group:'capture',icon:'webhook',slug:'curl',color:'073551',logoColor:'white'},
 {name:'Segment',note:'change the host',group:'keep',logo:'segment',color:'52BD94'},
 {name:'Sentry',note:'change the DSN',group:'keep',logo:'sentry',slug:'sentry',color:'362D59',logoColor:'white'},
 {name:'Python',note:'coming soon',group:'soon',logo:'python',slug:'python',color:'9CA3AF',logoColor:'white'},
 {name:'Rust',note:'coming soon',group:'soon',logo:'rust',slug:'rust',color:'9CA3AF',logoColor:'white'},
 {name:'Kotlin',note:'coming soon',group:'soon',logo:'kotlin',slug:'kotlin',color:'9CA3AF',logoColor:'white'},
];
