/** `soku files publish <file>` — publish a local file to a short-lived public URL.

The URL is a GCS signed URL that expires in ~30 minutes. The CLI always
surfaces `expires_at` prominently (TTY + JSON) so an agent that reuses a stale
URL downstream understands why the third-party fetch failed — a published URL
is not permanent.
 */

import { basename } from 'node:path'
import { readFileSync } from 'node:fs'

import { Command } from 'commander'

import { apiRequest } from '../http/client.js'
import { bold, dim, emitError, emitSuccess, ExitCode, red } from '../output/envelope.js'

const PUBLISH_PATH = '/api/cli/files/publish'

interface FilePublishResponse {
  url: string
  brand_path: string
  size_bytes: number
  content_type: string
  expires_in_seconds: number
  expires_at: string
}

function renderPublish(data: FilePublishResponse): string {
  const mins = Math.round(data.expires_in_seconds / 60)
  return [
    `${bold('Published')} ${data.brand_path} (${data.size_bytes} bytes, ${data.content_type})`,
    `${dim('url       ')} ${data.url}`,
    `${dim('expires_at')} ${data.expires_at} (in ~${mins} min)`,
    `${red('note      ')} this URL is temporary — re-publish if a downstream fetch fails after the expiry.`,
  ].join('\n')
}

export function registerFilesCommands(program: Command): void {
  const files = program
    .command('files')
    .description('Publish local files to short-lived public URLs (requires asset-publish)')

  files
    .command('publish <file>')
    .description('Publish a local file to a ~30-minute public signed URL')
    .option('--name <name>', 'Override the stored filename (defaults to the local basename)')
    .action(async (file: string, opts: { name?: string }) => {
      let bytes: Buffer
      try {
        bytes = readFileSync(file)
      } catch (err) {
        return emitError(
          'usage',
          `Could not read file: ${file}`,
          ExitCode.USAGE,
          (err as Error).message,
        )
      }
      const form = new FormData()
      form.append('file', new Blob([bytes]), opts.name ?? basename(file))

      const data = await apiRequest<FilePublishResponse>(PUBLISH_PATH, {
        method: 'POST',
        body: form,
        workspace: true,
      })
      emitSuccess(data, renderPublish)
    })
}
