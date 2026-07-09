#!/usr/bin/env node
/** Soku CLI entry point. */

import { Command } from 'commander'

import { registerAdsCommands } from './commands/ads.js'
import { registerAuthCommands } from './commands/auth.js'
import { registerAutomationCommands } from './commands/automation.js'
import { registerBrandCommands } from './commands/brand.js'
import { registerCallCommand } from './commands/call.js'
import { registerContextCommands } from './commands/context.js'
import { registerEgressCommands } from './commands/egress.js'
import { registerFilesCommands } from './commands/files.js'
import { registerGeneratedCommands } from './commands/generated.js'
import { registerMemoryCommands } from './commands/memory.js'
import { registerOrgCommands } from './commands/org.js'
import { registerReviewCommands } from './commands/review.js'
import { registerSeoHostingCommands } from './commands/seo-hosting.js'
import { registerSkillCommand } from './commands/skill.js'
import { maybeAutoUpdateCli, maybeAutoUpdateSkills, registerUpdateCommand } from './commands/update.js'
import { registerWorkspaceCommands } from './commands/workspace.js'
import { maybeNotifyUpdate, registerUpdateCheckCommand } from './update-check.js'
import { emitError, ExitCode } from './output/envelope.js'
import { CLI_VERSION } from './version.js'

const program = new Command()

program
  .name('soku')
  .description('Call Soku ads/GA4/PostHog data capabilities from any AI agent or shell.')
  .version(CLI_VERSION)

registerAuthCommands(program)
registerAutomationCommands(program)
registerOrgCommands(program)
registerBrandCommands(program)
registerWorkspaceCommands(program)
registerMemoryCommands(program)
registerGeneratedCommands(program)
registerAdsCommands(program)
registerCallCommand(program)
registerEgressCommands(program)
registerReviewCommands(program)
registerSeoHostingCommands(program)
registerContextCommands(program)
registerFilesCommands(program)
registerSkillCommand(program)
registerUpdateCommand(program)
registerUpdateCheckCommand(program)

function commandNames(command: Command): Set<string> {
  const names = new Set<string>()
  let current: Command | null = command
  while (current) {
    names.add(current.name())
    current = current.parent ?? null
  }
  return names
}

program.hook('preAction', async (_thisCommand, actionCommand) => {
  const names = commandNames(actionCommand)
  if (names.has('update-check') || names.has('update')) return
  await maybeAutoUpdateCli()
  if (process.env.SOKU_AUTO_UPDATE_CLI !== '1') {
    await maybeNotifyUpdate()
  }
  if (names.has('skill')) return
  await maybeAutoUpdateSkills()
})

program.parseAsync(process.argv).catch((err: unknown) => {
  emitError('unexpected', err instanceof Error ? err.message : String(err), ExitCode.RUNTIME)
})
