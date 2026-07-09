/** `soku ads <platform> <entity> <verb>` — Tier-2 ergonomic commands for the
 * highest-traffic ads-ops write entities (campaign / adset / ad-group / ad /
 * keyword).
 *
 * These wrap the same review-gated `/api/cli/call/ads/<action>` path the Tier-1
 * generated commands use, but expose platform-specific explicit flags, do light
 * validation up front, and always require `--summary`. Anything not surfaced as
 * a flag can still be passed with `-p key=value`. Exotic actions stay on the raw
 * `soku call ads <action>` escape hatch.
 *
 * Validation here is intentionally light (obvious missing-field guards only) —
 * the backend (`packages/ads_ops`) owns the authoritative validation, so we
 * don't duplicate its rules and risk drift.
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { Command } from 'commander'

import { emitError, ExitCode } from '../output/envelope.js'
import { buildGeneratedCommands, callTypedAction, loadManifest } from './generated.js'

type AdsPlatform = 'google' | 'meta'

/** Collect repeatable `-p key=value` into a payload object; values are parsed as
 * JSON when possible (so numbers/booleans/arrays work), else kept as strings. */
function collectParam(entry: string, acc: Record<string, unknown>): Record<string, unknown> {
  const eq = entry.indexOf('=')
  if (eq === -1) {
    emitError('usage', `-p must be key=value, got: ${entry}`, ExitCode.USAGE)
  }
  const key = entry.slice(0, eq)
  const raw = entry.slice(eq + 1)
  try {
    acc[key] = JSON.parse(raw)
  } catch {
    acc[key] = raw
  }
  return acc
}

function collectString(value: string, acc: string[]): string[] {
  acc.push(value)
  return acc
}

function parseIntFlag(flag: string, raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n)) {
    emitError('usage', `${flag} must be an integer, got: ${raw}`, ExitCode.USAGE)
  }
  return n
}

function parseJsonValue(flag: string, raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    emitError('usage', `${flag} must be valid JSON.`, ExitCode.USAGE)
  }
}

function readItemsFile(file: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return emitError(
      'usage',
      `--items-file must be readable JSON: ${file}`,
      ExitCode.USAGE,
      (err as Error).message,
    )
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    emitError('usage', '--items-file must contain a non-empty JSON array.', ExitCode.USAGE)
  }
  const seen = new Set<string>()
  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      emitError('usage', `items[${index}] must be an object.`, ExitCode.USAGE)
    }
    const clientRef = (item as Record<string, unknown>).client_ref
    if (typeof clientRef !== 'string' || clientRef.trim() === '') {
      emitError('usage', `items[${index}].client_ref is required.`, ExitCode.USAGE)
    }
    if (seen.has(clientRef)) {
      emitError('usage', `items[${index}].client_ref is duplicated: ${clientRef}`, ExitCode.USAGE)
    }
    seen.add(clientRef)
  })
  return parsed
}

/** Resolve a daily budget to micros from either human-units USD or raw micros.
 * `--budget-daily-micros` wins when both are given. Micros = USD * 1_000_000. */
export function resolveBudgetMicros(
  usd: string | undefined,
  micros: string | undefined,
): number | undefined {
  if (micros !== undefined) return parseIntFlag('--budget-daily-micros', micros)
  if (usd !== undefined) {
    const n = Number(usd)
    if (!Number.isFinite(n) || n < 0) {
      emitError('usage', `--budget-daily must be a non-negative number, got: ${usd}`, ExitCode.USAGE)
    }
    return Math.round(n * 1_000_000)
  }
  return undefined
}

interface WriteOpts {
  param: Record<string, unknown>
  summary: string
  /** From --account-id (optional on update/remove). Merged into the payload so
   * the backend can resolve the account when the target entity is not yet in
   * the local table. */
  accountId?: string
}

interface BulkCreateOpts extends WriteOpts {
  accountId: string
  itemsFile: string
}

/** Merge explicit fields + `-p` passthrough + `_summary`, then dispatch. */
function runAdsWrite(
  platform: AdsPlatform,
  action: string,
  fields: Record<string, unknown>,
  opts: WriteOpts,
): Promise<never> {
  const payload: Record<string, unknown> = { ...opts.param }
  payload.platform = platform
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) payload[k] = v
  }
  if (opts.accountId && payload.account_id === undefined) {
    payload.account_id = opts.accountId
  }
  payload._summary = opts.summary
  return callTypedAction('ads', action, payload)
}

function runMetaBulkCreate(action: string, opts: BulkCreateOpts): Promise<never> {
  return runAdsWrite(
    'meta',
    action,
    {
      account_id: opts.accountId,
      items: readItemsFile(opts.itemsFile),
    },
    opts,
  )
}

function addMetaBulkCreate(group: Command, action: string, entity: string): void {
  group
    .command('bulk-create')
    .description(`Bulk-create Meta ${entity} from a JSON items file`)
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .requiredOption('--items-file <json>', 'JSON array; each item requires client_ref')
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: BulkCreateOpts) => {
      await runMetaBulkCreate(action, opts)
    })
}

const PARAM_OPT: [string, string] = [
  '-p, --param <key=value>',
  'Set an extra payload field (repeatable); JSON-parsed when possible',
]
const SUMMARY_OPT: [string, string] = [
  '--summary <text>',
  'Human-readable description of this write; becomes the review approval card header',
]
/** Optional account id for update/remove: the backend needs it to resolve the
 * account when the parent entity has not yet synced into the local table, so
 * the common "create → immediately update/remove" flow does not 400. */
const ACCOUNT_ID_OPT: [string, string] = [
  '--account-id <id>',
  'Ad account id (aids resolution before the target entity syncs locally)',
]

interface UploadImageItem {
  client_ref: string
  name: string
  image_url?: string
  bytes_base64?: string
}

function nameFromUrl(rawUrl: string, index: number): string {
  try {
    const pathName = new URL(rawUrl).pathname
    const fileName = basename(pathName)
    return fileName || `image-${index + 1}.jpg`
  } catch {
    return `image-${index + 1}.jpg`
  }
}

function readLocalImageBytes(file: string): Buffer {
  try {
    return readFileSync(file)
  } catch (err) {
    return emitError(
      'usage',
      `Could not read file: ${file}`,
      ExitCode.USAGE,
      (err as Error).message,
    )
  }
}

export async function buildUploadImages(
  files: string[],
  urls: string[],
  namePrefix?: string,
): Promise<UploadImageItem[]> {
  const items: UploadImageItem[] = []
  for (const file of files) {
    const bytes = readLocalImageBytes(file)
    const fileName = basename(file)
    items.push({
      client_ref: file,
      bytes_base64: bytes.toString('base64'),
      name: namePrefix ? `${namePrefix}-${fileName}` : fileName,
    })
  }
  urls.forEach((url, index) => {
    const urlName = nameFromUrl(url, index)
    items.push({
      client_ref: url,
      image_url: url,
      name: namePrefix ? `${namePrefix}-${urlName}` : urlName,
    })
  })
  return items
}

/** Add `activate` / `pause` convenience verbs to a platform-specific entity
 * group. The public command tree already determines the platform; the helper
 * only injects the right active status and payload id field. */
function addActivatePause(
  group: Command,
  platform: AdsPlatform,
  idFlag: string,
  optionKey: string,
  payloadKey: string,
  action: string,
  entity: string,
  activeStatus: string,
): void {
  group
    .command('activate')
    .description(`Start serving the ${entity} (sets status ${activeStatus})`)
    .requiredOption(`${idFlag} <id>`, `${entity} id`)
    .option(...ACCOUNT_ID_OPT)
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { accountId?: string; summary: string; param: Record<string, unknown> } & Record<string, string>) => {
      await runAdsWrite(
        platform,
        action,
        { [payloadKey]: opts[optionKey], status: activeStatus },
        { ...opts, accountId: opts.accountId },
      )
    })

  group
    .command('pause')
    .description(`Stop serving the ${entity} (sets status PAUSED)`)
    .requiredOption(`${idFlag} <id>`, `${entity} id`)
    .option(...ACCOUNT_ID_OPT)
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { accountId?: string; summary: string; param: Record<string, unknown> } & Record<string, string>) => {
      await runAdsWrite(
        platform,
        action,
        { [payloadKey]: opts[optionKey], status: 'PAUSED' },
        { ...opts, accountId: opts.accountId },
      )
    })
}

function splitCommaList(value?: string): string[] | undefined {
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : undefined
}

function registerMetaAssetCommands(meta: Command): void {
  const asset = meta.command('asset').description('Upload and manage Meta ad assets')

  asset
    .command('upload-images [files...]')
    .description('Upload local files or public image URLs to the Meta asset library')
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .option('--url <url>', 'Public https image URL (repeatable)', collectString, [])
    .option('--concurrency <n>', 'Bulk upload concurrency (server clamps to 1-10)')
    .option('--name-prefix <prefix>', 'Prefix uploaded asset names')
    .action(
      async (
        files: string[],
        opts: { accountId: string; url: string[]; concurrency?: string; namePrefix?: string },
      ) => {
        const urls = opts.url ?? []
        if (files.length === 0 && urls.length === 0) {
          emitError(
            'usage',
            'upload-images requires at least one local file argument or --url.',
            ExitCode.USAGE,
          )
        }
        const images = await buildUploadImages(files, urls, opts.namePrefix)
        await callTypedAction('ads', 'upload_images', {
          platform: 'meta',
          account_id: opts.accountId,
          images,
          concurrency: opts.concurrency
            ? parseIntFlag('--concurrency', opts.concurrency)
            : undefined,
        })
      },
    )
}

function registerMetaAccountCommands(meta: Command): void {
  const account = meta.command('account').description('Read Meta ad account resources')

  account
    .command('pages')
    .description('List Facebook Pages promotable from a Meta ad account')
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { accountId: string; param: Record<string, unknown> }) => {
      await callTypedAction('ads', 'get_account_pages', {
        ...opts.param,
        platform: 'meta',
        account_id: opts.accountId,
      })
    })

  account
    .command('instagram')
    .description(
      'List Instagram accounts connected to a Meta ad account (use the returned id ' +
        'as instagram_user_id; a public @handle or Page id is rejected by the ads API)',
    )
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { accountId: string; param: Record<string, unknown> }) => {
      await callTypedAction('ads', 'get_connected_instagram_accounts', {
        ...opts.param,
        platform: 'meta',
        account_id: opts.accountId,
      })
    })
}

function registerMetaCampaignCommands(meta: Command): void {
  const campaign = meta.command('campaign').description('Create and manage Meta campaigns')

  campaign
    .command('get')
    .description('Read one Meta campaign by id')
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .requiredOption('--campaign-id <id>', 'Campaign id')
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (opts: { accountId: string; campaignId: string; param: Record<string, unknown> }) => {
        await callTypedAction('ads', 'get_campaign', {
          ...opts.param,
          platform: 'meta',
          account_id: opts.accountId,
          campaign_id: opts.campaignId,
        })
      },
    )

  campaign
    .command('create')
    .description('Create a Meta campaign (created paused)')
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .requiredOption('--name <name>', 'Campaign name')
    .requiredOption('--objective <objective>', 'Meta objective, e.g. OUTCOME_TRAFFIC')
    .option('--bidding-strategy <strategy>', 'Meta campaign-level bid strategy')
    .option('--special-ad-categories <list>', 'Comma-separated regulated categories')
    .option('--special-ad-category-country <list>', 'Comma-separated ISO country codes')
    .option('--start-time <time>', 'Meta start_time')
    .option('--stop-time <time>', 'Meta stop_time')
    .option('--lifetime-budget <amount>', 'Meta lifetime budget in account-currency cents')
    .option('--spend-cap <amount>', 'Meta spend cap in account-currency cents')
    .option('--buying-type <type>', 'Meta buying type')
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (opts: {
        accountId: string
        name: string
        objective: string
        biddingStrategy?: string
        specialAdCategories?: string
        specialAdCategoryCountry?: string
        startTime?: string
        stopTime?: string
        lifetimeBudget?: string
        spendCap?: string
        buyingType?: string
      } & WriteOpts) => {
        const categories = splitCommaList(opts.specialAdCategories)
        const regulated = categories?.some((c) => c && c !== 'NONE')
        if (regulated && !opts.specialAdCategoryCountry) {
          emitError(
            'usage',
            'meta regulated categories require --special-ad-category-country',
            ExitCode.USAGE,
          )
        }
        await runAdsWrite(
          'meta',
          'create_campaign',
          {
            account_id: opts.accountId,
            name: opts.name,
            objective: opts.objective,
            bidding_strategy: opts.biddingStrategy,
            special_ad_categories: categories,
            special_ad_category_country: splitCommaList(opts.specialAdCategoryCountry),
            start_time: opts.startTime,
            stop_time: opts.stopTime,
            lifetime_budget: opts.lifetimeBudget
              ? parseIntFlag('--lifetime-budget', opts.lifetimeBudget)
              : undefined,
            spend_cap: opts.spendCap ? parseIntFlag('--spend-cap', opts.spendCap) : undefined,
            buying_type: opts.buyingType,
          },
          opts,
        )
      },
    )

  addMetaBulkCreate(campaign, 'bulk_create_campaigns', 'campaigns')

  campaign
    .command('update')
    .description('Update a Meta campaign')
    .requiredOption('--campaign-id <id>', 'Campaign id')
    .option('--name <name>', 'New campaign name')
    .option('--status <status>', 'ACTIVE | PAUSED')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { campaignId: string; name?: string; status?: string } & WriteOpts) => {
      await runAdsWrite(
        'meta',
        'update_campaign',
        { campaign_id: opts.campaignId, name: opts.name, status: opts.status },
        opts,
      )
    })

  campaign
    .command('remove')
    .description('Remove a Meta campaign')
    .requiredOption('--campaign-id <id>', 'Campaign id')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { campaignId: string } & WriteOpts) => {
      await runAdsWrite('meta', 'remove_campaign', { campaign_id: opts.campaignId }, opts)
    })

  addActivatePause(
    campaign,
    'meta',
    '--campaign-id',
    'campaignId',
    'campaign_id',
    'update_campaign',
    'campaign',
    'ACTIVE',
  )
}

function registerMetaAdsetCommands(meta: Command): void {
  const adset = meta.command('adset').description('Create and manage Meta ad sets')

  adset
    .command('get')
    .description('Read one Meta ad set by id')
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .requiredOption('--adset-id <id>', 'Ad set id')
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (opts: { accountId: string; adsetId: string; param: Record<string, unknown> }) => {
        await callTypedAction('ads', 'get_adset', {
          ...opts.param,
          platform: 'meta',
          account_id: opts.accountId,
          adset_id: opts.adsetId,
        })
      },
    )

  adset
    .command('create')
    .description('Create a Meta ad set')
    .requiredOption('--campaign-id <id>', 'Parent campaign id')
    .requiredOption('--name <name>', 'Ad set name')
    .requiredOption('--optimization-goal <goal>', 'Meta optimization goal')
    .requiredOption('--billing-event <event>', 'Meta billing event')
    .option('--account-id <id>', 'Meta ad account id (aids resolution before campaign syncs)')
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (opts: {
        campaignId: string
        name: string
        optimizationGoal: string
        billingEvent: string
        accountId?: string
      } & WriteOpts) => {
        if (opts.param.targeting === undefined) {
          emitError(
            'usage',
            "meta ad sets require targeting — pass it with -p targeting='{...}'",
            ExitCode.USAGE,
          )
        }
        await runAdsWrite(
          'meta',
          'create_adset',
          {
            campaign_id: opts.campaignId,
            name: opts.name,
            optimization_goal: opts.optimizationGoal,
            billing_event: opts.billingEvent,
            account_id: opts.accountId,
          },
          opts,
        )
      },
    )

  addMetaBulkCreate(adset, 'bulk_create_adsets', 'ad sets')

  adset
    .command('update')
    .description('Update a Meta ad set')
    .requiredOption('--adset-id <id>', 'Ad set id')
    .option('--name <name>', 'New name')
    .option('--status <status>', 'ACTIVE | PAUSED')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { adsetId: string; name?: string; status?: string } & WriteOpts) => {
      await runAdsWrite(
        'meta',
        'update_adset',
        { adset_id: opts.adsetId, name: opts.name, status: opts.status },
        opts,
      )
    })

  adset
    .command('remove')
    .description('Remove a Meta ad set')
    .requiredOption('--adset-id <id>', 'Ad set id')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { adsetId: string } & WriteOpts) => {
      await runAdsWrite('meta', 'remove_adset', { adset_id: opts.adsetId }, opts)
    })

  addActivatePause(
    adset,
    'meta',
    '--adset-id',
    'adsetId',
    'adset_id',
    'update_adset',
    'ad set',
    'ACTIVE',
  )
}

function registerMetaCreativeCommands(meta: Command): void {
  const creative = meta.command('creative').description('Create and manage Meta ad creatives')

  creative
    .command('create')
    .description('Create a Meta ad creative for later ad creation')
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .requiredOption('--name <name>', 'Creative name')
    .requiredOption('--page-id <id>', 'Facebook Page id')
    .option('--image-hash <hash>', 'Image hash from `soku ads meta asset upload-images`')
    .option('--image-url <url>', 'Public https image URL (alternative to image hash)')
    .option('--video-id <id>', 'Meta video id')
    .option('--thumbnail-url <url>', 'Public https thumbnail URL for video creatives')
    .option('--thumbnail-image-hash <hash>', 'Image hash for video thumbnail')
    .option('--child-attachments <json>', 'Carousel child attachments JSON array')
    .option('--object-story-id <id>', 'Existing Page post id to boost')
    .option(
      '--asset-feed-spec <json>',
      'Dynamic creative (Advantage+) asset_feed_spec JSON (multi-asset; mutually exclusive with the single-asset flags)',
    )
    .option('--message <text>', 'Primary text')
    .option('--headline <text>', 'Headline')
    .option('--description <text>', 'Description')
    .option('--link <url>', 'Destination URL')
    .option('--caption <text>', 'Display URL caption')
    .option('--call-to-action-type <type>', 'CTA type, e.g. LEARN_MORE or SIGN_UP')
    .option('--url-tags <text>', 'Meta url_tags query string')
    .option('--lead-gen-form-id <id>', 'Lead form id for lead creatives')
    .option('--instagram-user-id <id>', 'Instagram user id')
    .option('--instagram-actor-id <id>', 'Instagram actor id')
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (
        opts: {
          accountId: string
          name: string
          pageId: string
          imageHash?: string
          imageUrl?: string
          videoId?: string
          thumbnailUrl?: string
          thumbnailImageHash?: string
          childAttachments?: string
          objectStoryId?: string
          assetFeedSpec?: string
          message?: string
          headline?: string
          description?: string
          link?: string
          caption?: string
          callToActionType?: string
          urlTags?: string
          leadGenFormId?: string
          instagramUserId?: string
          instagramActorId?: string
        } & WriteOpts,
      ) => {
        const primaryMedia = [
          opts.imageHash,
          opts.imageUrl,
          opts.videoId,
          opts.childAttachments,
          opts.objectStoryId,
          // Dynamic creative counts as a media source: asset_feed_spec carries
          // the assets. Listing it here also makes it mutually exclusive with
          // the single-asset flags via the length>1 check below.
          opts.assetFeedSpec,
        ].filter((value) => value !== undefined)
        if (primaryMedia.length === 0) {
          emitError(
            'usage',
            'creative create requires one media source: --image-hash, --image-url, --video-id, --child-attachments, --object-story-id, or --asset-feed-spec.',
            ExitCode.USAGE,
          )
        }
        if (primaryMedia.length > 1) {
          emitError(
            'usage',
            'creative create accepts only one primary media source.',
            ExitCode.USAGE,
          )
        }
        await runAdsWrite(
          'meta',
          'create_ad_creative',
          {
            account_id: opts.accountId,
            name: opts.name,
            page_id: opts.pageId,
            image_hash: opts.imageHash,
            image_url: opts.imageUrl,
            video_id: opts.videoId,
            thumbnail_url: opts.thumbnailUrl,
            thumbnail_image_hash: opts.thumbnailImageHash,
            child_attachments: opts.childAttachments
              ? parseJsonValue('--child-attachments', opts.childAttachments)
              : undefined,
            object_story_id: opts.objectStoryId,
            asset_feed_spec: opts.assetFeedSpec
              ? parseJsonValue('--asset-feed-spec', opts.assetFeedSpec)
              : undefined,
            message: opts.message,
            headline: opts.headline,
            description: opts.description,
            link: opts.link,
            caption: opts.caption,
            call_to_action_type: opts.callToActionType,
            url_tags: opts.urlTags,
            lead_gen_form_id: opts.leadGenFormId,
            instagram_user_id: opts.instagramUserId,
            instagram_actor_id: opts.instagramActorId,
          },
          opts,
        )
      },
    )

  addMetaBulkCreate(creative, 'bulk_create_ad_creatives', 'ad creatives')
}

function registerMetaAdCommands(meta: Command): void {
  const ad = meta.command('ad').description('Create and manage Meta ads')

  ad
    .command('get')
    .description('Read one Meta ad by id')
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .requiredOption('--ad-id <id>', 'Meta ad id')
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { accountId: string; adId: string; param: Record<string, unknown> }) => {
      await callTypedAction('ads', 'get_ad', {
        ...opts.param,
        platform: 'meta',
        account_id: opts.accountId,
        ad_id: opts.adId,
      })
    })

  ad
    .command('create')
    .description('Create a Meta ad under an ad set')
    .requiredOption('--adset-id <id>', 'Parent Meta ad set id')
    .requiredOption('--name <name>', 'Ad name')
    .option('--account-id <id>', 'Meta ad account id (aids resolution before parent syncs)')
    .option('--creative-id <id>', 'Existing Meta creative id')
    .option('--creative <json>', 'Inline Meta creative spec JSON', (v) =>
      parseJsonValue('--creative', v),
    )
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (
        opts: {
          adsetId: string
          name: string
          accountId?: string
          creativeId?: string
          creative?: unknown
        } & WriteOpts,
      ) => {
        const hasCreative =
          opts.creativeId !== undefined ||
          opts.creative !== undefined ||
          opts.param.creative_id !== undefined ||
          opts.param.creative !== undefined
        if (!hasCreative) {
          emitError(
            'usage',
            'meta ad create requires --creative-id, --creative, or -p creative_id=...',
            ExitCode.USAGE,
          )
        }
        await runAdsWrite(
          'meta',
          'create_ad',
          {
            adset_id: opts.adsetId,
            name: opts.name,
            account_id: opts.accountId,
            creative_id: opts.creativeId,
            creative: opts.creative,
          },
          opts,
        )
      },
    )

  addMetaBulkCreate(ad, 'bulk_create_ads', 'ads')

  ad
    .command('update')
    .description('Update a Meta ad')
    .requiredOption('--ad-id <id>', 'Ad id')
    .option('--status <status>', 'ACTIVE | PAUSED')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { adId: string; status?: string } & WriteOpts) => {
      await runAdsWrite('meta', 'update_ad', { ad_id: opts.adId, status: opts.status }, opts)
    })

  ad
    .command('remove')
    .description('Remove a Meta ad')
    .requiredOption('--ad-id <id>', 'Ad id')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { adId: string } & WriteOpts) => {
      await runAdsWrite('meta', 'remove_ad', { ad_id: opts.adId }, opts)
    })

  addActivatePause(ad, 'meta', '--ad-id', 'adId', 'ad_id', 'update_ad', 'ad', 'ACTIVE')
}

function registerMetaLeadFormCommands(meta: Command): void {
  const leadForm = meta.command('lead-form').description('Create Meta lead forms')

  leadForm
    .command('create')
    .description('Create a Meta lead form attached to a Page (review-gated)')
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .requiredOption('--name <name>', 'Lead form display name')
    .requiredOption('--page-id <id>', 'Facebook Page id from `soku ads meta account pages`')
    .requiredOption(
      '--questions <json>',
      'JSON array of question objects, e.g. \'[{"type":"EMAIL"},{"type":"FULL_NAME"}]\'',
    )
    .requiredOption('--privacy-policy-url <url>', 'Public https privacy policy URL')
    .requiredOption(
      '--follow-up-action-url <url>',
      'Public https follow-up URL (Meta rejects create without it)',
    )
    .option('--privacy-policy-link-text <text>', 'Privacy policy link text', 'Privacy Policy')
    .option('--context-card <json>', 'Optional context card JSON object shown before the form')
    .option(
      '--thank-you-page <json>',
      'Optional thank-you page JSON object (website_url must be public https)',
    )
    .option('--locale <locale>', 'Form locale, e.g. en_US')
    .option('--optimized-for-quality', "Toggle Meta's higher-intent optimization")
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (
        opts: {
          accountId: string
          name: string
          pageId: string
          questions: string
          privacyPolicyUrl: string
          followUpActionUrl: string
          privacyPolicyLinkText: string
          contextCard?: string
          thankYouPage?: string
          locale?: string
          optimizedForQuality?: boolean
        } & WriteOpts,
      ) => {
        await runAdsWrite(
          'meta',
          'create_lead_form',
          {
            account_id: opts.accountId,
            name: opts.name,
            page_id: opts.pageId,
            questions: parseJsonValue('--questions', opts.questions),
            privacy_policy: {
              url: opts.privacyPolicyUrl,
              link_text: opts.privacyPolicyLinkText,
            },
            follow_up_action_url: opts.followUpActionUrl,
            context_card: opts.contextCard
              ? parseJsonValue('--context-card', opts.contextCard)
              : undefined,
            thank_you_page: opts.thankYouPage
              ? parseJsonValue('--thank-you-page', opts.thankYouPage)
              : undefined,
            locale: opts.locale,
            is_optimized_for_quality: opts.optimizedForQuality,
          },
          opts,
        )
      },
    )
}

function registerMetaAudienceCommands(meta: Command): void {
  const audience = meta
    .command('audience')
    .description('Create Meta custom and lookalike audiences')

  audience
    .command('create-custom')
    .description('Create a Meta custom audience (review-gated)')
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .requiredOption('--name <name>', 'Audience display name')
    .requiredOption(
      '--subtype <subtype>',
      'CUSTOM | WEBSITE | APP | OFFLINE_CONVERSION | CLAIM | PARTNER | ...',
    )
    .option('--description <text>', 'Audience description')
    .option('--customer-file-source <source>', 'Source of uploaded data for CUSTOM subtype')
    .option('--pixel-id <id>', 'Pixel id for WEBSITE-subtype audiences')
    .option('--rule <json>', 'Flexible-rule JSON for rule-based subtypes (WEBSITE/ENGAGEMENT)')
    .option('--retention-days <n>', 'Days a user stays in the audience')
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (
        opts: {
          accountId: string
          name: string
          subtype: string
          description?: string
          customerFileSource?: string
          pixelId?: string
          rule?: string
          retentionDays?: string
        } & WriteOpts,
      ) => {
        await runAdsWrite(
          'meta',
          'create_custom_audience',
          {
            account_id: opts.accountId,
            name: opts.name,
            subtype: opts.subtype,
            description: opts.description,
            customer_file_source: opts.customerFileSource,
            pixel_id: opts.pixelId,
            rule: opts.rule ? parseJsonValue('--rule', opts.rule) : undefined,
            retention_days: opts.retentionDays
              ? parseIntFlag('--retention-days', opts.retentionDays)
              : undefined,
          },
          opts,
        )
      },
    )

  audience
    .command('create-lookalike')
    .description('Create a Meta lookalike audience from a source custom audience (review-gated)')
    .requiredOption('--account-id <id>', 'Meta ad account id')
    .requiredOption('--name <name>', 'Lookalike audience display name')
    .requiredOption(
      '--source-audience-id <id>',
      'Source custom audience id from `soku call ads list_custom_audiences`',
    )
    .requiredOption('--country <iso2>', 'ISO-2 country code')
    .requiredOption('--ratio <n>', 'Lookalike ratio (e.g. 0.01 = top 1%, 0.05 = top 5%)')
    .option('--lookalike-spec <json>', 'Optional explicit lookalike_spec JSON object')
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (
        opts: {
          accountId: string
          name: string
          sourceAudienceId: string
          country: string
          ratio: string
          lookalikeSpec?: string
        } & WriteOpts,
      ) => {
        const ratio = Number(opts.ratio)
        if (!Number.isFinite(ratio) || ratio <= 0) {
          emitError('usage', '--ratio must be a positive number, e.g. 0.01', ExitCode.USAGE)
        }
        await runAdsWrite(
          'meta',
          'create_lookalike_audience',
          {
            account_id: opts.accountId,
            name: opts.name,
            source_audience_id: opts.sourceAudienceId,
            country: opts.country,
            ratio,
            lookalike_spec: opts.lookalikeSpec
              ? parseJsonValue('--lookalike-spec', opts.lookalikeSpec)
              : undefined,
          },
          opts,
        )
      },
    )
}

function registerGoogleCampaignCommands(google: Command): void {
  const campaign = google.command('campaign').description('Create and manage Google campaigns')

  campaign
    .command('create')
    .description('Create a Google campaign (created paused)')
    .requiredOption('--account-id <id>', 'Google ad account id')
    .requiredOption('--name <name>', 'Campaign name')
    .requiredOption('--campaign-type <type>', 'SEARCH | DISPLAY | SHOPPING | VIDEO')
    .option('--budget-daily-micros <micros>', 'Daily budget in micros')
    .option('--budget-daily <amount>', 'Daily budget in account currency')
    .option('--bidding-strategy <strategy>', 'Google bidding strategy')
    .option('--start-date <date>', 'YYYY-MM-DD')
    .option('--end-date <date>', 'YYYY-MM-DD')
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (opts: {
        accountId: string
        name: string
        campaignType: string
        budgetDailyMicros?: string
        budgetDaily?: string
        biddingStrategy?: string
        startDate?: string
        endDate?: string
      } & WriteOpts) => {
        const budgetMicros = resolveBudgetMicros(opts.budgetDaily, opts.budgetDailyMicros)
        if (budgetMicros === undefined) {
          emitError(
            'usage',
            'google campaigns require --budget-daily-micros (or --budget-daily)',
            ExitCode.USAGE,
          )
        }
        await runAdsWrite(
          'google',
          'create_campaign',
          {
            account_id: opts.accountId,
            name: opts.name,
            campaign_type: opts.campaignType,
            budget_daily_micros: budgetMicros,
            bidding_strategy: opts.biddingStrategy,
            start_date: opts.startDate,
            end_date: opts.endDate,
          },
          opts,
        )
      },
    )

  campaign
    .command('update')
    .description('Update a Google campaign')
    .requiredOption('--campaign-id <id>', 'Campaign id')
    .option('--name <name>', 'New campaign name')
    .option('--status <status>', 'ENABLED | PAUSED')
    .option('--budget-daily-micros <micros>', 'Daily budget in micros')
    .option('--budget-daily <amount>', 'Daily budget in account currency')
    .option('--start-date <date>', 'YYYY-MM-DD')
    .option('--end-date <date>', 'YYYY-MM-DD')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (opts: {
        campaignId: string
        name?: string
        status?: string
        budgetDailyMicros?: string
        budgetDaily?: string
        startDate?: string
        endDate?: string
      } & WriteOpts) => {
        await runAdsWrite(
          'google',
          'update_campaign',
          {
            campaign_id: opts.campaignId,
            name: opts.name,
            status: opts.status,
            budget_daily_micros: resolveBudgetMicros(opts.budgetDaily, opts.budgetDailyMicros),
            start_date: opts.startDate,
            end_date: opts.endDate,
          },
          opts,
        )
      },
    )

  campaign
    .command('remove')
    .description('Remove a Google campaign')
    .requiredOption('--campaign-id <id>', 'Campaign id')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { campaignId: string } & WriteOpts) => {
      await runAdsWrite('google', 'remove_campaign', { campaign_id: opts.campaignId }, opts)
    })

  campaign
    .command('pmax-create')
    .description('Create a Google Performance Max campaign')
    .requiredOption('--account-id <id>', 'Google ad account id')
    .requiredOption('--name <name>', 'Campaign name')
    .requiredOption('--budget-amount-micros <micros>', 'Daily budget in micros')
    .requiredOption('--bidding-strategy <strategy>', 'Google bidding strategy')
    .requiredOption('--asset-group <json>', 'PMax asset group payload JSON', (v) =>
      parseJsonValue('--asset-group', v),
    )
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (opts: {
        accountId: string
        name: string
        budgetAmountMicros: string
        biddingStrategy: string
        assetGroup: unknown
      } & WriteOpts) => {
        await runAdsWrite(
          'google',
          'create_pmax_campaign',
          {
            account_id: opts.accountId,
            name: opts.name,
            budget_amount_micros: parseIntFlag('--budget-amount-micros', opts.budgetAmountMicros),
            bidding_strategy: opts.biddingStrategy,
            asset_group: opts.assetGroup,
          },
          opts,
        )
      },
    )

  addActivatePause(
    campaign,
    'google',
    '--campaign-id',
    'campaignId',
    'campaign_id',
    'update_campaign',
    'campaign',
    'ENABLED',
  )
}

function registerGoogleAdGroupCommands(google: Command): void {
  const adGroup = google.command('ad-group').description('Create and manage Google ad groups')

  adGroup
    .command('create')
    .description('Create a Google ad group')
    .requiredOption('--campaign-id <id>', 'Parent campaign id')
    .requiredOption('--name <name>', 'Ad group name')
    .option('--account-id <id>', 'Google ad account id (aids resolution before campaign syncs)')
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (opts: { campaignId: string; name: string; accountId?: string } & WriteOpts) => {
        await runAdsWrite(
          'google',
          'create_ad_group',
          { campaign_id: opts.campaignId, name: opts.name, account_id: opts.accountId },
          opts,
        )
      },
    )

  adGroup
    .command('update')
    .description('Update a Google ad group')
    .requiredOption('--ad-group-id <id>', 'Ad group id')
    .option('--name <name>', 'New name')
    .option('--status <status>', 'ENABLED | PAUSED')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { adGroupId: string; name?: string; status?: string } & WriteOpts) => {
      await runAdsWrite(
        'google',
        'update_ad_group',
        { ad_group_id: opts.adGroupId, name: opts.name, status: opts.status },
        opts,
      )
    })

  adGroup
    .command('remove')
    .description('Remove a Google ad group')
    .requiredOption('--ad-group-id <id>', 'Ad group id')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { adGroupId: string } & WriteOpts) => {
      await runAdsWrite('google', 'remove_ad_group', { ad_group_id: opts.adGroupId }, opts)
    })

  addActivatePause(
    adGroup,
    'google',
    '--ad-group-id',
    'adGroupId',
    'ad_group_id',
    'update_ad_group',
    'ad group',
    'ENABLED',
  )
}

function registerGoogleAdCommands(google: Command): void {
  const ad = google.command('ad').description('Create and manage Google ads')

  ad
    .command('create')
    .description('Create a Google responsive search ad under an ad group')
    .requiredOption('--ad-group-id <id>', 'Parent Google ad group id')
    .requiredOption('--final-urls <json>', 'JSON array of final URLs', (v) =>
      parseJsonValue('--final-urls', v),
    )
    .requiredOption('--headlines <json>', 'JSON array of headlines', (v) =>
      parseJsonValue('--headlines', v),
    )
    .requiredOption('--descriptions <json>', 'JSON array of descriptions', (v) =>
      parseJsonValue('--descriptions', v),
    )
    .option('--account-id <id>', 'Google ad account id (aids resolution before parent syncs)')
    .option('--path1 <text>', 'Google display path 1')
    .option('--path2 <text>', 'Google display path 2')
    .option('--tracking-url-template <text>', 'Google tracking URL template')
    .option('--final-url-suffix <text>', 'Google final URL suffix')
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (
        opts: {
          adGroupId: string
          finalUrls: unknown
          headlines: unknown
          descriptions: unknown
          accountId?: string
          path1?: string
          path2?: string
          trackingUrlTemplate?: string
          finalUrlSuffix?: string
        } & WriteOpts,
      ) => {
        await runAdsWrite(
          'google',
          'create_ad',
          {
            adset_id: opts.adGroupId,
            final_urls: opts.finalUrls,
            headlines: opts.headlines,
            descriptions: opts.descriptions,
            account_id: opts.accountId,
            path1: opts.path1,
            path2: opts.path2,
            tracking_url_template: opts.trackingUrlTemplate,
            final_url_suffix: opts.finalUrlSuffix,
          },
          opts,
        )
      },
    )

  ad
    .command('update')
    .description('Update a Google ad')
    .requiredOption('--ad-id <id>', 'Ad id')
    .option('--status <status>', 'ENABLED | PAUSED')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { adId: string; status?: string } & WriteOpts) => {
      await runAdsWrite('google', 'update_ad', { ad_id: opts.adId, status: opts.status }, opts)
    })

  ad
    .command('remove')
    .description('Remove a Google ad')
    .requiredOption('--ad-id <id>', 'Ad id')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(async (opts: { adId: string } & WriteOpts) => {
      await runAdsWrite('google', 'remove_ad', { ad_id: opts.adId }, opts)
    })

  addActivatePause(ad, 'google', '--ad-id', 'adId', 'ad_id', 'update_ad', 'ad', 'ENABLED')
}

function registerGoogleKeywordCommands(google: Command): void {
  const keyword = google.command('keyword').description('Manage Google ad group keywords')

  keyword
    .command('add')
    .description('Add keywords to a Google ad group')
    .requiredOption('--ad-group-id <id>', 'Ad group id')
    .requiredOption('--keywords <list>', 'Comma-separated keyword texts')
    .option('--account-id <id>', 'Google ad account id (aids resolution before ad group syncs)')
    .requiredOption(...SUMMARY_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (opts: { adGroupId: string; keywords: string; accountId?: string } & WriteOpts) => {
        await runAdsWrite(
          'google',
          'add_keywords',
          {
            ad_group_id: opts.adGroupId,
            keywords: splitCommaList(opts.keywords),
            account_id: opts.accountId,
          },
          opts,
        )
      },
    )

  keyword
    .command('update')
    .description('Update a Google keyword criterion')
    .requiredOption('--ad-group-id <id>', 'Ad group id')
    .requiredOption('--criterion-id <id>', 'Keyword criterion id')
    .option('--status <status>', 'ENABLED | PAUSED')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (opts: {
        adGroupId: string
        criterionId: string
        status?: string
      } & WriteOpts) => {
        await runAdsWrite(
          'google',
          'update_keyword',
          {
            ad_group_id: opts.adGroupId,
            criterion_id: opts.criterionId,
            status: opts.status,
          },
          opts,
        )
      },
    )

  keyword
    .command('remove')
    .description('Remove a Google keyword criterion')
    .requiredOption('--ad-group-id <id>', 'Ad group id')
    .requiredOption('--criterion-id <id>', 'Keyword criterion id')
    .requiredOption(...SUMMARY_OPT)
    .option(...ACCOUNT_ID_OPT)
    .option(...PARAM_OPT, collectParam, {})
    .action(
      async (opts: { adGroupId: string; criterionId: string } & WriteOpts) => {
        await runAdsWrite(
          'google',
          'remove_keyword',
          { ad_group_id: opts.adGroupId, criterion_id: opts.criterionId },
          opts,
        )
      },
    )
}

/** Attach platform-first Tier-2 entity sub-groups to the shared `ads` group. */
export function registerAdsEntities(ads: Command): void {
  const meta = ads.command('meta').description('Meta Ads write commands')
  registerMetaAccountCommands(meta)
  registerMetaAssetCommands(meta)
  registerMetaCampaignCommands(meta)
  registerMetaAdsetCommands(meta)
  registerMetaCreativeCommands(meta)
  registerMetaAdCommands(meta)
  registerMetaLeadFormCommands(meta)
  registerMetaAudienceCommands(meta)

  const google = ads.command('google').description('Google Ads write commands')
  registerGoogleCampaignCommands(google)
  registerGoogleAdGroupCommands(google)
  registerGoogleAdCommands(google)
  registerGoogleKeywordCommands(google)
}

/** Register the `ads` command group: Tier-1 generated data actions (read +
 * write) plus Tier-2 ergonomic entity commands, on a single shared group. */
export function registerAdsCommands(program: Command): void {
  const groups = buildGeneratedCommands(program, loadManifest(), { namespaces: ['ads'] })
  const ads =
    groups.get('ads') ?? program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
}
