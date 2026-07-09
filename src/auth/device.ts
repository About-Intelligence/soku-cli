/** RFC 8628 device authorization client. */

import { resolveApiBaseUrl } from '../config.js'

export interface DeviceAuthorization {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export interface TokenResult {
  access_token: string
  token_type: string
  expires_in: number
  scope: string
  workspace?: TokenWorkspace
}

export interface TokenWorkspace {
  organization_id: string
  brand_id: string
  organization_name?: string | null
  organization_slug?: string | null
  brand_name?: string | null
  brand_slug?: string | null
}

const CLIENT_ID = 'soku-cli'
const WORKSPACE_SELECTION_CAPABILITY = 'workspace_selection_v1'
export const DEFAULT_RESOURCE_BUNDLES = [
  'data-infra',
  'conversion-groups-write',
  'seo-hosting',
  'automation',
  'ads-write',
  'context-hub',
  'asset-publish',
  'brand-skills',
] as const
export const DEFAULT_RESOURCE_SCOPE = DEFAULT_RESOURCE_BUNDLES.join(',')

export async function requestDeviceCode(opts: {
  apiBase?: string
  scope?: string
}): Promise<DeviceAuthorization> {
  const base = resolveApiBaseUrl(opts.apiBase)
  const res = await fetch(`${base}/api/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: opts.scope ?? DEFAULT_RESOURCE_SCOPE,
      client_capabilities: [WORKSPACE_SELECTION_CAPABILITY],
    }),
  })
  if (!res.ok) {
    throw new Error(`Failed to start device authorization (HTTP ${res.status})`)
  }
  return (await res.json()) as DeviceAuthorization
}

export type PollOutcome =
  | { status: 'token'; token: TokenResult }
  | { status: 'denied' }
  | { status: 'expired' }

/** Poll until the grant is approved/denied/expired, honoring slow_down (+5s). */
export async function pollForToken(opts: {
  deviceCode: string
  interval: number
  expiresIn: number
  apiBase?: string
  onTick?: () => void
}): Promise<PollOutcome> {
  const base = resolveApiBaseUrl(opts.apiBase)
  let interval = Math.max(opts.interval, 1)
  const deadline = Date.now() + opts.expiresIn * 1000

  while (Date.now() < deadline) {
    await sleep(interval * 1000)
    opts.onTick?.()
    let res: Response
    try {
      res = await fetch(`${base}/api/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: opts.deviceCode,
          client_id: CLIENT_ID,
        }),
      })
    } catch {
      // Transient network blip — keep polling until the deadline rather than
      // giving up. RFC 8628 only terminates on a definitive error code.
      continue
    }
    if (res.ok) {
      return { status: 'token', token: (await res.json()) as TokenResult }
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    switch (body.error) {
      case 'authorization_pending':
        break
      case 'slow_down':
        interval += 5
        break
      case 'access_denied':
        return { status: 'denied' }
      case 'expired_token':
        return { status: 'expired' }
      default:
        // Unknown/transient server error (e.g. 5xx, 429): don't treat as a
        // terminal expiry — keep polling until the deadline.
        break
    }
  }
  return { status: 'expired' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
