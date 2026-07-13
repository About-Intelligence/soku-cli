# Data Capabilities

Use typed commands for read workflows. Read `capability-flow.md` first when you
are unfamiliar with the namespace.

## Ads: Cached First

Start with account and schema discovery:

```bash
soku ads list-ad-accounts --platform google
soku ads list-dimensions --platform google --account-id <account_id>
```

Use cached analytics for normal reporting:

```bash
soku ads query-single-dimension \
  --account-id <account_id> \
  --dimension campaign \
  --date-start 2026-05-01 \
  --date-end 2026-05-07

soku ads query-multi-dimension \
  --account-id <account_id> \
  --dimensions '["campaign","device"]' \
  --date-start 2026-05-01 \
  --date-end 2026-05-07
```

Use `query-single-dimension` for CPA, ROAS, conversion group fan-out, or one
dimension. Use `query-multi-dimension` for raw multi-dimensional breakdowns.

`--platform` accepts `google`, `meta`, `tiktok`, or `chatgpt_ads`:

```bash
soku ads list-ad-accounts --platform chatgpt_ads
soku ads query-single-dimension \
  --platform chatgpt_ads \
  --account-id <account_id> \
  --dimension campaign \
  --date-start 2026-05-01 \
  --date-end 2026-05-07
```

For reporting, ChatGPT Ads is still cached-first. `query-multi-dimension` does
not support it (use `query-single-dimension` instead). Campaign/ad-unit writes
now exist as review-gated `ads` actions; use `ads-write.md` for the write flow.

## Google Ads GAQL Fallback

For common account, campaign, ad, keyword, search-term, and bidding-strategy
reports, prefer the predefined report command over ad-hoc GAQL. It selects a
stable set of columns and uses the last 30 days when dates are omitted:

```bash
soku ads get-google-ads-report \
  --platform google \
  --account-id <account_id> \
  --report-type campaign \
  --start-date 2026-06-01 \
  --end-date 2026-06-30
```

Supported report types are `account`, `campaign`, `ad`, `keyword`,
`search_term`, and `bidding_strategy`.

Use GAQL only when cached actions cannot answer the request.

`get-resource-metadata` needs a native Google credential; accounts connected
through a proxy credential (Pipedream / Composio) fail with
`field_metadata_unavailable` (400). In that case skip field discovery and run
`gaql-search` directly — an unknown field fails with `gaql_invalid_query`
naming the offending field.

```bash
soku ads get-resource-metadata --platform google --account-id <account_id> --resource-name campaign
soku ads gaql-search \
  --platform google \
  --account-id <account_id> \
  --dimensions '["date","campaign"]' \
  --metrics '["cost","clicks"]' \
  --limit 20
```

Do not write full `SELECT ... FROM ...` GAQL SQL. `gaql-search` takes structured
`dimensions`, `metrics`, `filters`, `date_range`, `order_by`, and `limit`; the
server translates them.

## GA4

Prefer cached overview commands:

```bash
soku ga4 list-properties
soku ga4 get-property-overview --property-id <property_id>
soku ga4 list-top-pages --property-id <property_id>
soku ga4 list-traffic-sources --property-id <property_id>
soku ga4 get-daily-trend --property-id <property_id>
soku ga4 get-conversion-overview --property-id <property_id>
soku ga4 list-events --property-id <property_id>
```

Use live fallback only for dimensions, metrics, filters, or custom definitions
not covered by cached commands:

```bash
soku ga4 get-metadata --property-id <property_id>
soku ga4 run-report \
  --property-id <property_id> \
  --metrics '["activeUsers"]' \
  --dimensions '["sessionDefaultChannelGroup"]'
```

## PostHog

Do not ask the user for a project id before listing accessible projects:

```bash
soku posthog list-projects
soku posthog list-tools --project-id <project_id>
soku posthog query --project-id <project_id> --tool read-data-schema --arguments '{}'
soku posthog query --project-id <project_id> --tool execute-sql \
  --arguments '{"query":"SELECT count() FROM events WHERE event = '\''$pageview'\''"}'
```

The CLI exposes read allowlisted PostHog tools. Writes and unvetted MCP tools
stay outside the generated command tree.

## Raw Calls

Use `soku call <namespace> <action>` only when a typed command is missing:

```bash
soku call ads list_ad_accounts -p platform=google
soku call ads query_single_dimension --payload '{"account_id":"123","dimension":"campaign"}'
soku call posthog query --payload '{"project_id":"12345","tool":"execute-sql","arguments":{"query":"SELECT count() FROM events"}}'
```

Review-gated writes through `soku call` require `--summary`.
