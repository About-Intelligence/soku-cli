/** `soku memory` — read memory entries scoped to the active brand. */

import { Command } from 'commander'

import { apiRequest } from '../http/client.js'
import { bold, dim, emitSuccess, table } from '../output/envelope.js'

export type MemoryType = 'user' | 'feedback' | 'reference' | 'task' | 'reflection'

export interface MemoryEntry {
  type: MemoryType
  name: string
  description: string
  content: string
  updated_at: string
}

interface MemoryListResponse {
  brand_id: string
  entries: MemoryEntry[]
  groups: Record<string, MemoryEntry[]>
  count: number
}

interface MemoryGetResponse {
  brand_id: string
  entry: MemoryEntry
}

export function memoryListPath(opts: { type?: string; query?: string }): string {
  const params = new URLSearchParams()
  if (opts.type) params.set('type', opts.type)
  if (opts.query) params.set('q', opts.query)
  const query = params.toString()
  return `/api/cli/memory${query ? `?${query}` : ''}`
}

export function renderMemoryEntries(entries: MemoryEntry[]): string {
  return table(
    entries.map((entry) => ({
      type: entry.type,
      name: entry.name,
      description: entry.description,
      updated: entry.updated_at,
      preview: compactPreview(entry.content),
    })),
    [
      { key: 'type', header: 'TYPE' },
      { key: 'name', header: 'NAME' },
      { key: 'description', header: 'DESCRIPTION' },
      { key: 'updated', header: 'UPDATED' },
      { key: 'preview', header: 'PREVIEW' },
    ],
  )
}

export function renderMemoryEntry(entry: MemoryEntry): string {
  const header = `${bold('Memory')}: ${entry.type}/${entry.name}`
  const description = entry.description ? `\n${bold('Description')}: ${entry.description}` : ''
  const updated = entry.updated_at ? `\n${bold('Updated')}: ${entry.updated_at}` : ''
  const body = entry.content.trim() || dim('(empty)')
  return `${header}${description}${updated}\n\n${body}`
}

export function registerMemoryCommands(program: Command): void {
  const memory = program
    .command('memory')
    .description('Read memory entries for the active brand workspace')

  memory
    .command('list')
    .description('List current-brand memory entries with content previews')
    .option('--type <type>', 'Filter by memory type: user, feedback, reference, task, reflection')
    .option('-q, --query <text>', 'Search name, description, or content')
    .action(async (opts: { type?: string; query?: string }) => {
      const data = await apiRequest<MemoryListResponse>(memoryListPath(opts), { workspace: true })
      emitSuccess(data, (d) => renderMemoryEntries(d.entries))
    })

  memory
    .command('search <query>')
    .description('Search current-brand memory entries')
    .option('--type <type>', 'Filter by memory type: user, feedback, reference, task, reflection')
    .action(async (query: string, opts: { type?: string }) => {
      const data = await apiRequest<MemoryListResponse>(
        memoryListPath({ type: opts.type, query }),
        { workspace: true },
      )
      emitSuccess(data, (d) => renderMemoryEntries(d.entries))
    })

  memory
    .command('get <type> <name>')
    .description('Read one full current-brand memory entry')
    .action(async (type: string, name: string) => {
      const data = await apiRequest<MemoryGetResponse>(
        `/api/cli/memory/${encodeURIComponent(type)}/${encodeURIComponent(name)}`,
        { workspace: true },
      )
      emitSuccess(data, (d) => renderMemoryEntry(d.entry))
    })
}

function compactPreview(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized
}
