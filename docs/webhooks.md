# Webhooks

Point GitHub, Stripe, RevenueCat or anything else at your Worker and its events land in the same stream as your product events, so an agent can line a release, a payment or a subscription change up with a change in your numbers.

A webhook is one more **source**: your project gets a publishable key whose source is the provider name (`github`), and every event it brings is stamped `sender = 'github'`. Each event is stored whole: the payload exactly as the provider sent it is the event's `data`.

## Set one up

```sh
slurp project webhook PROJECT github
```

This prints the URL (`https://<your-worker>/hooks/github?key=slurp_pk_…`), the secret, and the few steps to paste them in. Running it again changes nothing: it finds or creates the `github` key once, and shows the same URL and secret.

| Provider | Where | Signature | Secret |
|---|---|---|---|
| `github` | Repository > Settings > Webhooks > Add webhook. Content type `application/json`. | `X-Hub-Signature-256` | **Generated** by the Worker: paste the secret Slurp prints. |
| `stripe` | Developers > Webhooks > Add endpoint. | `Stripe-Signature` (must be within 5 minutes) | **Issued by Stripe**: reveal the endpoint's `whsec_…` and give it to Slurp with `slurp project webhook PROJECT stripe --secret whsec_…`. Until then the endpoint refuses deliveries. |
| `revenuecat` | Project settings > Integrations > Webhooks > New. Paste the URL and, as the **Authorization header value**, the secret. | The `Authorization` header (RevenueCat sends the value you typed, on every delivery) | **Generated**: the secret Slurp prints. RevenueCat's optional HMAC signing is not supported yet. |
| `generic` | Anything that can POST. | Optional `X-Slurp-Signature: sha256=<hex>` | **Generated**: the secret Slurp prints. |

Anything with a wrong or missing signature is refused with `401`; a `ping` from GitHub is acknowledged and not stored. Only the webhook's own **publishable** key works in the URL (a secret key, the admin token, or a key of another source is refused).

## What gets stored

One `track` event per delivery:

| Provider | `event` | `id` | `timestamp` |
|---|---|---|---|
| GitHub | `github.<event>` plus `.<action>` when there is one: `github.release.published`, `github.workflow_run.completed`, `github.deployment_status.created` | `github:<X-GitHub-Delivery>` | From the payload (the release's `published_at`, a run's `updated_at`...), else when it arrived |
| Stripe | `stripe.<type>`: `stripe.invoice.paid` | the Stripe event id (`evt_…`) | Stripe's `created` |
| RevenueCat | `revenuecat.<type lowercased>`: `revenuecat.initial_purchase`, `revenuecat.renewal`, `revenuecat.cancellation`, `revenuecat.billing_issue`; the dashboard's test event is `revenuecat.test` | `revenuecat:<event id>` (a retry reuses it) | RevenueCat's `event_timestamp_ms` |
| Generic | `?event=NAME`, else the body's `type` or `event`, else `webhook` | `generic:<Idempotency-Key, X-Request-Id or X-Delivery-Id>`; else, when the body has its own `timestamp`, a hash of the body; else no `id`: every POST is its own event | The body's `timestamp`, else when it arrived (for a delivery with an id, the first time it arrived) |

`data` is the payload as sent (numbers and key order untouched); `context.webhook` says which provider and delivery. A JSON array is wrapped as `{"items": [...]}` and a body that is not JSON (generic only) as `{"raw": "..."}`. A provider that redelivers the same delivery id makes one row, not two, and a delivery that carries no time of its own keeps the time it **first** arrived, however late the redelivery is.

### Sending your own events through `generic`

Tell Slurp which POSTs are retries of each other by sending an `Idempotency-Key` (or `X-Request-Id`, or `X-Delivery-Id`) header:

```sh
curl -X POST "$URL&event=deploy.finished" \
  -H "Idempotency-Key: deploy-2026-11-07-17" \
  -H "content-type: application/json" \
  -d '{"env":"prod","ok":true}'
```

Sending that request again, for instance after a timeout, is one event. Without the header, a body that carries its own `timestamp` is one event per identical body, and a body with **neither** (a heartbeat, for example) is a new event each time it is sent: Slurp cannot tell a retry from a repeat, and a duplicate is safer than a silently dropped event.

```sql
SELECT sender, event, count(*) FROM events WHERE sender IN ('github', 'stripe', 'revenuecat') GROUP BY 1, 2;
SELECT happened_at, kind, tag, repo, environment, state FROM releases ORDER BY happened_at DESC;
SELECT date_trunc('month', happened_at) AS month, sum(price) AS usd FROM revenue
 WHERE environment = 'PRODUCTION' AND type IN ('INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE') GROUP BY 1 ORDER BY 1;
```

The `releases` view lists GitHub releases and deployment statuses. Draw them on a chart, or join them to see what changed after each one.

The `revenue` view lists RevenueCat events: `type`, `app_user_id`, `product_id`, `price` (USD, negative for a refund), `price_in_purchased_currency` with `currency`, `store`, `environment`, `period_type`, `renewal_number` and `country_code`. RevenueCat sends test-store activity as `environment = 'SANDBOX'`, so filter on `PRODUCTION` for real money. The `app_user_id` is the id your app gave RevenueCat, so set the same one with `identify` and a purchase joins to what that person did first. The dashboard's test event is stored in `events` but left out of the view.

## Secrets

Each connection stores its own secret on the Worker, next to its key, so asking again shows the same value. For `github`, `revenuecat` and `generic` the Worker generates a random secret the first time. Stripe chooses its own, so you pass it with `--secret whsec_…`; until then the endpoint refuses deliveries, and passing it again replaces it. Because the secret is stored, rotating `ADMIN_TOKEN` does not change any webhook secret.

**To rotate a webhook**, revoke its key and connect again. The old URL stops working on its next request, and the new URL carries a new key:

```sh
slurp project key list PROJECT --scope publishable     # find the KEY_ID of the github key
slurp project key revoke PROJECT KEY_ID
slurp project webhook PROJECT github                    # a new URL and a new secret: paste both into GitHub
```

For Stripe, roll the secret in Stripe and give Slurp the new one: `slurp project webhook PROJECT stripe --secret whsec_…`. Add a revoke first if the URL should change too.

## Limits

- **Preview.** These are tested against the providers' documented signature examples and payload shapes, not against live deliveries yet.
- Payloads over 1 MiB (a very large GitHub push) are refused with `413`, not truncated. Subscribe to the events you need.
- A repeated delivery id with a *different* payload is a conflict at import: the first copy is kept and the other is set aside in `_slurp.problems` (`slurp health` reports it). Providers do not do this.
- Linear and other providers are not built in: send them to `generic`, optionally signed.
