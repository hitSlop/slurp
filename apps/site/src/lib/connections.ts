export type Connection = {name:string;description:string;icon?:string;logo?:string;status:'Available locally'|'Works today'|'Exploring';href?:string};
export type ConnectionGroup = {id:string;title:string;items:Connection[]};
const future=(name:string,description:string,logo?:string,icon='connections'):Connection=>({name,description,logo,icon,status:'Exploring'});
export const current:Connection[]=[
 {name:'JavaScript / TypeScript',description:'Browser and Node event capture. Install the private SDK from source.',icon:'code',status:'Available locally',href:'/docs/#capture'},
 {name:'HTTP API',description:'Send canonical events as NDJSON to your configured backend.',icon:'globe',status:'Works today',href:'/docs/#http'},
 ...['Claude Code','Codex','Cursor'].map((name,i):Connection=>({name,description:'Run the Slurp CLI and query your local DuckDB data.',logo:['claude','codex','cursor'][i],status:'Works today',href:'/docs/#agent'}))
];
export const groups:ConnectionGroup[]=[
 {id:'capture',title:'More ways to capture',items:[future('Rust','A dedicated capture SDK.'),future('Python','Capture from Python applications.'),future('File uploads','Bring CSV, Parquet, JSONL, and logs.',undefined,'file')]},
 {id:'analytics',title:'Product analytics inputs',items:['Mixpanel','Amplitude','Segment','RudderStack'].map(n=>future(n,'Bring existing product events into Slurp.'))},
 {id:'errors',title:'Errors and support inputs',items:[future('Sentry','Errors and releases.','sentry'),future('Bugsnag','Errors and stability.'),future('Customer chat','Support conversations and transcripts.'),future('Bug reports','Feedback directly from users.')]},
 {id:'business',title:'Business and code inputs',items:[future('Stripe','Payments and subscriptions.','stripe'),future('GitHub','Pushes, pull requests, and releases.','github'),future('Linear','Issues and cycles.','linear')]},
 {id:'pipelines',title:'Pipeline inputs',items:[future('Webhooks','Translate incoming tool payloads into events.',undefined,'webhook'),future('Kafka','Receive events from your pipelines.')]},
 {id:'outputs',title:'Outputs and agent destinations',items:[future('Webhooks','Deliver events to your own endpoint.',undefined,'webhook'),future('Slack','Alerts in a channel.','slack'),future('Linear','Create an issue from a finding.','linear'),future('GitHub','Open an issue or pull request.','github'),...['Muse','Grok','OpenAI','dots','Custom agents'].map(n=>future(n,'Route relevant events to an agent.'))]}
];
