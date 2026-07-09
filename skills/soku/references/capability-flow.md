# Capability Discovery Flow

Use this discover -> inspect -> run loop for data capabilities. `--help` is the
authoritative runtime surface for command names, flags, required params, and
usage notes.

## 1. Confirm Workspace

```bash
soku auth status
soku workspace status
```

A default `soku auth login` reaches the entire CLI surface — there is no
resource model to grant or check (writes are still HITL-approved). Just make
sure you are signed in and pointed at the right org/brand.

## 2. Discover Namespaces

```bash
soku --help
soku ads --help
soku ga4 --help
soku posthog --help
```

Common read actions:

- `soku ads list-ad-accounts`
- `soku ads list-dimensions`
- `soku ads query-single-dimension`
- `soku ads query-multi-dimension`
- `soku ads gaql-search`
- `soku ga4 list-properties`
- `soku ga4 get-property-overview`
- `soku posthog list-projects`
- `soku posthog list-tools`
- `soku posthog query`

## 3. Inspect Before Running

```bash
soku ads query-single-dimension --help
```

Never guess flags. Object and list flags take JSON strings, for example:

```bash
soku ads query-single-dimension --filters '{"campaign_id":["123"]}'
```

## 4. Run

```bash
soku ads list-ad-accounts --platform google
soku ads query-single-dimension \
  --account-id 1234567890 \
  --dimension campaign \
  --date-start 2026-05-01 \
  --date-end 2026-05-07
```

## Raw Escape Hatch

Use raw calls only when a typed sub-command is missing:

```bash
soku call ads query_single_dimension \
  --payload '{"account_id":"1234567890","dimension":"campaign","date_start":"2026-05-01","date_end":"2026-05-07"}'
```

## Typical Chaining

1. `soku ads list-ad-accounts` -> pick `account_id`.
2. `soku ads list-dimensions` -> learn legal dimensions, metrics, and filters.
3. `soku ads query-single-dimension` or `query-multi-dimension`.
4. Use `gaql-search` only if cached actions cannot expose the needed
   Google-native field or segment combination.
