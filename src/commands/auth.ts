/** `soku auth login | status | logout` */

import { Command } from 'commander'
import open from 'open'
import qrcode from 'qrcode-terminal'

import {
  pollForToken,
  requestDeviceCode,
  type DeviceAuthorization,
  type TokenWorkspace,
} from '../auth/device.js'
import { clearToken, loadToken, saveToken } from '../auth/store.js'
import { updateConfig } from '../config.js'
import { apiRequest } from '../http/client.js'
import { cyan, dim, emitError, emitSuccess, ExitCode, green } from '../output/envelope.js'

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Authenticate the CLI with Soku')

  auth
    .command('login')
    .description('Sign in via device authorization')
    .option('--api-base <url>', 'Override the API base URL')
    .option('--no-wait', 'Print the verification URL and exit without polling (for agents)')
    .option('--device-code <code>', 'Resume polling for a previously started login')
    .option('--qr', 'Render the verification URL as a QR code')
    .action(async (opts) => {
      // Split-flow resume: an agent started with --no-wait, the human approved,
      // now poll for the token.
      if (opts.deviceCode) {
        await pollAndStore({
          deviceCode: opts.deviceCode,
          interval: 5,
          expiresIn: 900,
          apiBase: opts.apiBase,
        })
        return
      }

      let auth: DeviceAuthorization
      try {
        auth = await requestDeviceCode({ apiBase: opts.apiBase })
      } catch (err) {
        emitError('device_code_failed', (err as Error).message, ExitCode.RUNTIME)
      }

      if (!opts.wait) {
        // Non-blocking: hand the URL back to the caller (agent surfaces it to the
        // human), then exit. The agent resumes with `--device-code` next turn.
        emitSuccess({
          device_code: auth.device_code,
          user_code: auth.user_code,
          verification_uri: auth.verification_uri,
          verification_uri_complete: auth.verification_uri_complete,
          expires_in: auth.expires_in,
          interval: auth.interval,
          next: `soku auth login --device-code ${auth.device_code}`,
        }, (d) =>
          [
            `${green('✓')} Login started`,
            `  Open: ${cyan(d.verification_uri_complete)}`,
            `  Code: ${cyan(d.user_code)}`,
            `  Expires in: ${d.expires_in}s`,
            '',
            dim('After approval, resume with:'),
            `  ${d.next}`,
          ].join('\n'),
        )
      }

      // Interactive (human) path.
      process.stderr.write(
        `\n  To connect, visit:\n    ${auth.verification_uri}\n  and enter code:\n    ${auth.user_code}\n\n`,
      )
      if (opts.qr) {
        qrcode.generate(auth.verification_uri_complete, { small: true })
      }
      await open(auth.verification_uri_complete).catch(() => undefined)
      process.stderr.write('  Waiting for approval...\n')

      await pollAndStore({
        deviceCode: auth.device_code,
        interval: auth.interval,
        expiresIn: auth.expires_in,
        apiBase: opts.apiBase,
      })
    })

  auth
    .command('status')
    .description('Show the current session')
    .action(async () => {
      const token = await loadToken()
      if (!token) {
        emitError('not_authenticated', 'Not signed in.', ExitCode.AUTH, 'Run `soku auth login`.')
      }
      const me = await apiRequest<AuthStatusMe>('/api/cli/me')
      emitSuccess(authStatusPayload(me), renderAuthStatus)
    })

  auth
    .command('logout')
    .description('Remove the stored session token')
    .action(async () => {
      await clearToken()
      emitSuccess({ signed_out: true }, () => `${green('✓')} Signed out`)
    })
}

/** `/api/cli/me` response. `is_platform_admin` is optional so the CLI stays
 * compatible with servers that predate the field. */
export interface AuthStatusMe {
  owner_id: string
  scope_type: string
  is_platform_admin?: boolean
}

/** JSON envelope payload for `auth status`; passes server fields through. */
export function authStatusPayload(me: AuthStatusMe): { signed_in: true } & AuthStatusMe {
  return { signed_in: true, ...me }
}

/** Human (TTY) renderer for `auth status`. */
export function renderAuthStatus(d: AuthStatusMe): string {
  const scope = d.is_platform_admin ? `${d.scope_type} — platform admin` : d.scope_type
  return `${green('✓')} Signed in ${dim(`(${scope})`)}\n  owner: ${cyan(d.owner_id)}`
}

async function pollAndStore(opts: {
  deviceCode: string
  interval: number
  expiresIn: number
  apiBase?: string
}): Promise<void> {
  const outcome = await pollForToken(opts)
  if (outcome.status === 'denied') {
    emitError('access_denied', 'Authorization was denied.', ExitCode.AUTH)
  }
  if (outcome.status === 'expired') {
    emitError(
      'expired',
      'The login request expired before approval.',
      ExitCode.AUTH,
      'Run `soku auth login` again.',
    )
  }
  await saveToken(outcome.token.access_token)
  const workspaceConfigured = storeTokenWorkspace(outcome.token.workspace)
  const days = Math.round(outcome.token.expires_in / 86400)
  emitSuccess(
    {
      signed_in: true,
      expires_in: outcome.token.expires_in,
      scope: outcome.token.scope,
      workspace_configured: workspaceConfigured,
      workspace: outcome.token.workspace ?? null,
    },
    () =>
      `${green('✓')} Signed in ${dim(`(token valid ~${days} days)`)}\n  ${dim(
        workspaceConfigured ? 'Next: soku ads list-ad-accounts' : 'Next: soku org list',
      )}`,
  )
}

export function storeTokenWorkspace(workspace: TokenWorkspace | undefined): boolean {
  if (!workspace?.organization_id || !workspace?.brand_id) return false
  updateConfig({
    activeOrgId: workspace.organization_id,
    activeBrandId: workspace.brand_id,
  })
  return true
}
