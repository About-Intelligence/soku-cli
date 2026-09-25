/** Meta video ads from local files: `soku ads meta asset upload-video`,
 * `soku ads meta asset video`, `soku ads meta ad deploy-videos`.
 *
 * Every command here uploads local files to Soku first (`media-upload.ts`) and
 * sends the ads write a `media_asset_id`, never a URL: the approval may come
 * hours later, and the URL Meta downloads from is signed by the server only
 * when the approved write runs.
 *
 * `deploy-videos` is the one to reach for when the goal is ads: it asks for a
 * single approval that uploads every video, waits for Meta to process them and
 * creates one PAUSED ad per video. `upload-video` only adds videos to the ad
 * library (one approval each; the inbox link approves them together).
 *
 * Neither command waits for the decision. The person has to receive the
 * approval link first, and a command blocked on the decision would only print
 * it once it was over; `soku review wait <id...>` is the step after.
 */

import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

import { Command } from 'commander'

import { ApiError, apiRequest } from '../http/client.js'
import { dim, emitError, emitSuccessExit, ExitCode } from '../output/envelope.js'
import { callTypedAction } from './generated.js'
import { mediaContentType, uploadMediaFile } from './media-upload.js'

/** Where a batch item's video comes from; exactly one per item. */
const VIDEO_SOURCES = ['file', 'media_asset_id', 'video_id', 'file_url'] as const

export interface VideoItemInput {
  client_ref?: string
  name?: string
  file?: string
  media_asset_id?: string
  video_id?: string
  file_url?: string
  [key: string]: unknown
}

/** A stable, unique client_ref per item: the handler appends it to creative and
 * ad names, which is how an ambiguous batch result is looked up afterwards. */
function uniqueRef(base: string, used: Set<string>): string {
  let ref = base
  for (let n = 2; used.has(ref); n++) ref = `${base}-${n}`
  used.add(ref)
  return ref
}

function stem(path: string): string {
  return basename(path, extname(path))
}

/** Items for `deploy-videos`, before any local file is uploaded. Returns the
 * items or a usage error message. */
export function buildVideoItems(input: {
  files: string[]
  videoIds: string[]
  itemsFromFile?: VideoItemInput[]
  name?: string
}): VideoItemInput[] | { error: string } {
  const used = new Set<string>()
  const items: VideoItemInput[] = []
  for (const file of input.files) {
    items.push({ client_ref: uniqueRef(stem(file), used), name: input.name ?? stem(file), file })
  }
  for (const id of input.videoIds) {
    items.push({
      client_ref: uniqueRef(`video-${id}`, used),
      name: input.name ?? `Video ${id}`,
      video_id: id,
    })
  }
  for (const [index, raw] of (input.itemsFromFile ?? []).entries()) {
    const sources = VIDEO_SOURCES.filter((key) => raw[key])
    if (sources.length !== 1) {
      return {
        error: `items-file item ${index} needs exactly one of file, media_asset_id, video_id or file_url`,
      }
    }
    const fallback = raw.file ? stem(raw.file) : `item-${index + 1}`
    items.push({
      ...raw,
      client_ref: uniqueRef(String(raw.client_ref ?? fallback), used),
      name: String(raw.name ?? input.name ?? fallback),
    })
  }
  if (items.length === 0) {
    return { error: 'deploy-videos needs at least one video file, --video-id or --items-file item' }
  }
  for (const item of items) {
    if (item.file) {
      const type = mediaContentType(item.file, 'video')
      if (typeof type !== 'string') return { error: type.error }
    }
  }
  return items
}

function listNames(names: string[]): string {
  const shown = names.slice(0, 5).join(', ')
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown
}

/** Default approval header for a video ad batch. It repeats the ad set id —
 * the server requires every literal target id to appear in the summary. */
export function deployVideosSummary(adsetId: string, names: string[]): string {
  const noun = names.length === 1 ? 'ad' : 'ads'
  return `Create ${names.length} paused Meta video ${noun} in ad set ${adsetId}: ${listNames(names)}`
}

export function uploadVideoSummary(accountId: string, name: string): string {
  return `Upload video ${name} to Meta ad account ${accountId}`
}

function progress(line: string): void {
  // Progress is for a person at a terminal; an agent reads the final JSON.
  if (process.stderr.isTTY) process.stderr.write(`${dim(line)}\n`)
}

/** Replace each item's local `file` with the `media_asset_id` it uploads to. */
async function uploadItemFiles(items: VideoItemInput[]): Promise<VideoItemInput[]> {
  const resolved: VideoItemInput[] = []
  for (const item of items) {
    if (!item.file) {
      resolved.push(item)
      continue
    }
    const { file, ...rest } = item
    progress(`Uploading ${basename(file)} to Soku…`)
    try {
      const media = await uploadMediaFile(file, 'video')
      resolved.push({ ...rest, media_asset_id: media.media_asset_id })
    } catch (err) {
      return emitError(
        'upload_failed',
        `Could not upload ${file}: ${(err as Error).message}`,
        ExitCode.RUNTIME,
        'Nothing was submitted for approval. Fix the file and run the command again.',
      )
    }
  }
  return resolved
}

export interface VideoUploadOutcome {
  file: string
  media_asset_id?: string
  review_id?: string
  status?: string
  approve_url?: string | null
  error?: string
}

/** One submitted upload, read the same way whether a person must approve it
 * (`pending_review`) or an Always rule already did (`auto_approved`). */
export function outcomeFromCall(file: string, mediaAssetId: string, body: unknown): VideoUploadOutcome {
  const r = (body ?? {}) as Record<string, unknown>
  if (r.status === 'pending_review') {
    return {
      file,
      media_asset_id: mediaAssetId,
      review_id: r.pending_review_id as string,
      status: 'pending',
      approve_url: (r.approve_url as string | null | undefined) ?? null,
    }
  }
  return {
    file,
    media_asset_id: mediaAssetId,
    review_id: r.review_id as string | undefined,
    status: r.auto_approved ? String(r.status ?? 'approved') : String(r.status ?? 'submitted'),
    approve_url: null,
  }
}

export function renderVideoUploads(data: {
  videos: VideoUploadOutcome[]
  inbox_url: string | null
  review_ids: string[]
}): string {
  const lines: string[] = []
  for (const v of data.videos) {
    if (v.error) {
      lines.push(`✖ ${basename(v.file)} — ${v.error}`)
    } else if (v.status === 'pending') {
      lines.push(`• ${basename(v.file)} — waiting for approval (review ${v.review_id})`)
    } else {
      lines.push(`• ${basename(v.file)} — ${v.status} (review ${v.review_id})`)
    }
  }
  if (data.inbox_url) lines.push(`  ${dim('Approve in Soku:')} ${data.inbox_url}`)
  if (data.review_ids.length > 0) {
    lines.push(`  ${dim('Continue when decided:')} soku review wait ${data.review_ids.join(' ')}`)
  }
  return lines.join('\n')
}

function readItemsFile(path: string): VideoItemInput[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array of items')
    return parsed as VideoItemInput[]
  } catch (err) {
    return emitError('usage', `Could not read --items-file ${path}`, ExitCode.USAGE, (err as Error).message)
  }
}

function collect(value: string, acc: string[]): string[] {
  acc.push(value)
  return acc
}

export function registerMetaVideoAssetCommands(asset: Command): void {
  asset
    .command('upload-video <files...>')
    .description(
      'Upload local video files to the Meta ad library (one approval each; the inbox link approves them together). To create ads from videos use `soku ads meta ad deploy-videos`.',
    )
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .option('--name-prefix <prefix>', 'Prefix the library names')
    .action(async (files: string[], opts: { accountId: string; namePrefix?: string }) => {
      for (const file of files) {
        const type = mediaContentType(file, 'video')
        if (typeof type !== 'string') emitError('usage', type.error, ExitCode.USAGE)
      }
      const videos: VideoUploadOutcome[] = []
      let inboxUrl: string | null = null
      for (const file of files) {
        const name = opts.namePrefix ? `${opts.namePrefix}-${basename(file)}` : basename(file)
        progress(`Uploading ${basename(file)} to Soku…`)
        try {
          const media = await uploadMediaFile(file, 'video')
          const body = await apiRequest<Record<string, unknown>>('/api/cli/call/ads/upload_video', {
            method: 'POST',
            workspace: true,
            throwOnError: true,
            body: {
              platform: 'meta',
              account_id: opts.accountId,
              media_asset_id: media.media_asset_id,
              name,
              _summary: uploadVideoSummary(opts.accountId, name),
            },
          })
          inboxUrl = (body.inbox_url as string | null | undefined) ?? inboxUrl
          videos.push(outcomeFromCall(file, media.media_asset_id, body))
        } catch (err) {
          const message = err instanceof ApiError ? err.message : (err as Error).message
          videos.push({ file, error: message })
        }
      }
      const reviewIds = videos.flatMap((v) => (v.review_id && !v.error ? [v.review_id] : []))
      const failed = videos.some((v) => v.error)
      emitSuccessExit(
        { videos, inbox_url: inboxUrl, review_ids: reviewIds },
        failed ? ExitCode.RUNTIME : ExitCode.OK,
        renderVideoUploads,
      )
    })

  asset
    .command('video')
    .description('Check whether a Meta ad-library video has finished processing (ready to use in an ad)')
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .requiredOption('--video-id <id>', 'Meta video id (from upload-video or deploy-videos)')
    .action(async (opts: { accountId: string; videoId: string }) => {
      await callTypedAction('ads', 'get_video', {
        platform: 'meta',
        account_id: opts.accountId,
        video_id: opts.videoId,
      })
    })
}

interface DeployVideosOpts {
  accountId: string
  adsetId: string
  pageId: string
  videoId: string[]
  itemsFile?: string
  name?: string
  message?: string
  headline?: string
  description?: string
  link?: string
  cta?: string
  urlTags?: string
  leadGenFormId?: string
  instagramUserId?: string
  destination?: string
  summary?: string
  param: Record<string, unknown>
}

export function registerMetaVideoAdCommands(
  ad: Command,
  collectParam: (entry: string, acc: Record<string, unknown>) => Record<string, unknown>,
): void {
  ad.command('deploy-videos [files...]')
    .description(
      'Upload videos and create one PAUSED Meta ad per video in an ad set — a single approval covers the uploads, the creatives and the ads',
    )
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .requiredOption('--adset-id <id>', 'Meta ad set that receives the paused ads')
    .requiredOption('--page-id <id>', 'Facebook Page the ads run as')
    .option('--video-id <id>', 'A video already in the ad library (repeatable)', collect, [])
    .option(
      '--items-file <path>',
      'JSON array of items for per-video copy: each names one of "file", "video_id", "media_asset_id" or "file_url", with optional client_ref, name, message, headline, description, link, thumbnail_url',
    )
    .option('--name <name>', 'Base name for creatives and ads (default: each file name)')
    .option('--message <text>', 'Primary text shared by every ad')
    .option('--headline <text>', 'Headline shared by every ad')
    .option('--description <text>', 'Link description shared by every ad')
    .option('--link <url>', 'Landing URL for the call to action')
    .option('--cta <type>', 'Call-to-action type, e.g. LEARN_MORE or SHOP_NOW')
    .option('--url-tags <tags>', 'URL parameters appended to the link')
    .option('--lead-gen-form-id <id>', 'Lead form for lead ads (then each video needs a thumbnail)')
    .option('--instagram-user-id <id>', 'Instagram identity from `soku ads meta account instagram`')
    .option(
      '--destination <type>',
      'WEBSITE_AND_SHOP or WEBSITE_AND_SHOP_OPT_OUT — Meta v26 requires an explicit choice when --link is set',
    )
    .option('--summary <text>', 'Approval card header (default names the ad set and the videos)')
    .option(
      '-p, --param <key=value>',
      'Set an extra payload field (repeatable); JSON-parsed when possible',
      collectParam,
      {},
    )
    .action(async (files: string[], opts: DeployVideosOpts) => {
      const built = buildVideoItems({
        files,
        videoIds: opts.videoId ?? [],
        itemsFromFile: opts.itemsFile ? readItemsFile(opts.itemsFile) : undefined,
        name: opts.name,
      })
      if (!Array.isArray(built)) return emitError('usage', built.error, ExitCode.USAGE)
      const items = await uploadItemFiles(built)
      const names = items.map((item) => String(item.name))
      await callTypedAction('ads', 'deploy_video_ads_batch', {
        ...opts.param,
        platform: 'meta',
        account_id: opts.accountId,
        adset_id: opts.adsetId,
        page_id: opts.pageId,
        items,
        message: opts.message,
        headline: opts.headline,
        description: opts.description,
        link: opts.link,
        call_to_action_type: opts.cta,
        url_tags: opts.urlTags,
        lead_gen_form_id: opts.leadGenFormId,
        instagram_user_id: opts.instagramUserId,
        destination_spec: opts.destination ? { destination_type: opts.destination } : undefined,
        _summary: opts.summary?.trim() || deployVideosSummary(opts.adsetId, names),
      })
    })
}
