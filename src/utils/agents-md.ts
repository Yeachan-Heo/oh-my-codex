import {
  OMX_MODELS_END_MARKER,
  OMX_MODELS_START_MARKER,
} from './agents-model-table.js'

export const OMX_GENERATED_AGENTS_MARKER = '<!-- omx:generated:agents-md -->'
export const OMX_MANAGED_AGENTS_START_MARKER = '<!-- OMX:AGENTS:START -->'
export const OMX_MANAGED_AGENTS_END_MARKER = '<!-- OMX:AGENTS:END -->'
export const OMX_USER_POLICY_START_MARKER = '<!-- USER:OMX:POLICY:START -->'
export const OMX_USER_POLICY_END_MARKER = '<!-- USER:OMX:POLICY:END -->'

export const OMX_AGENTS_CONTRACT_HEADING =
  '# oh-my-codex - Intelligent Multi-Agent Orchestration'
const OMX_AGENTS_CONTRACT_REQUIRED_TEXT = [
  OMX_GENERATED_AGENTS_MARKER,
  OMX_AGENTS_CONTRACT_HEADING,
  'AGENTS.md is the top-level operating contract for the workspace.',
] as const
const AUTONOMY_DIRECTIVE_END_MARKER = '<!-- END AUTONOMY DIRECTIVE -->'

export function isOmxGeneratedAgentsMd(content: string): boolean {
  return content.includes(OMX_GENERATED_AGENTS_MARKER)
}

export function hasOmxManagedAgentsSections(content: string): boolean {
  return (
    isOmxGeneratedAgentsMd(content) ||
    (content.includes(OMX_MANAGED_AGENTS_START_MARKER) &&
      content.includes(OMX_MANAGED_AGENTS_END_MARKER)) ||
    (content.includes(OMX_MODELS_START_MARKER) &&
      content.includes(OMX_MODELS_END_MARKER))
  )
}

export function hasOmxAgentsContract(content: string): boolean {
  if (candidateHasOmxAgentsContract(content)) return true

  const startIndex = content.indexOf(OMX_MANAGED_AGENTS_START_MARKER)
  const endIndex = content.indexOf(OMX_MANAGED_AGENTS_END_MARKER)
  if (startIndex === -1 || endIndex <= startIndex) return false

  const managedBlock = content.slice(
    startIndex + OMX_MANAGED_AGENTS_START_MARKER.length,
    endIndex,
  )
  return candidateHasOmxAgentsContract(managedBlock)
}

function candidateHasOmxAgentsContract(content: string): boolean {
  return OMX_AGENTS_CONTRACT_REQUIRED_TEXT.every((text) =>
    content.includes(text),
  )
}

export function extractUserOmxPolicyBlocks(content: string): string[] {
  const blocks: string[] = []
  let searchFrom = 0

  while (searchFrom < content.length) {
    const startIndex = content.indexOf(OMX_USER_POLICY_START_MARKER, searchFrom)
    if (startIndex === -1) break

    const endIndex = content.indexOf(OMX_USER_POLICY_END_MARKER, startIndex)
    if (endIndex === -1) break

    const blockEnd = endIndex + OMX_USER_POLICY_END_MARKER.length
    blocks.push(content.slice(startIndex, blockEnd))
    searchFrom = blockEnd
  }

  return blocks
}

export function preserveUserOmxPolicyBlocks(
  existingContent: string,
  nextContent: string,
): string {
  const missingBlocks = extractUserOmxPolicyBlocks(existingContent).filter(
    (block) => !nextContent.includes(block),
  )
  if (missingBlocks.length === 0) return nextContent

  const normalizedNext = nextContent.endsWith('\n') ? nextContent : `${nextContent}\n`
  return `${normalizedNext.trimEnd()}\n\n${missingBlocks.join('\n\n')}\n`
}
export function upsertManagedAgentsBlock(
  existingContent: string,
  managedContent: string,
): string {
  const normalizedExisting = existingContent.endsWith('\n')
    ? existingContent
    : `${existingContent}\n`
  const normalizedManaged = managedContent.endsWith('\n')
    ? managedContent
    : `${managedContent}\n`
  const block = [
    OMX_MANAGED_AGENTS_START_MARKER,
    normalizedManaged.trimEnd(),
    OMX_MANAGED_AGENTS_END_MARKER,
  ].join('\n')

  const startIndex = normalizedExisting.indexOf(OMX_MANAGED_AGENTS_START_MARKER)
  const endIndex = normalizedExisting.indexOf(OMX_MANAGED_AGENTS_END_MARKER)

  if (startIndex >= 0 && endIndex > startIndex) {
    const replaceEnd = endIndex + OMX_MANAGED_AGENTS_END_MARKER.length
    const next = `${normalizedExisting.slice(0, startIndex)}${block}${normalizedExisting.slice(replaceEnd)}`
    return next.endsWith('\n') ? next : `${next}\n`
  }

  if (isOmxGeneratedAgentsMd(normalizedExisting)) {
    return preserveUserOmxPolicyBlocks(normalizedExisting, normalizedManaged)
  }

  return `${normalizedExisting.trimEnd()}\n\n${block}\n`
}

export function addGeneratedAgentsMarker(content: string): string {
  if (content.includes(OMX_GENERATED_AGENTS_MARKER)) return content

  const autonomyDirectiveEnd = content.indexOf(AUTONOMY_DIRECTIVE_END_MARKER)
  if (autonomyDirectiveEnd >= 0) {
    const insertAt = autonomyDirectiveEnd + AUTONOMY_DIRECTIVE_END_MARKER.length
    const lineEnding = content.startsWith('\r\n', insertAt) ? '\r\n' : '\n'
    const hasImmediateNewline = content.startsWith(lineEnding, insertAt)
    const insertionPoint = hasImmediateNewline ? insertAt + lineEnding.length : insertAt
    return (
      content.slice(0, insertionPoint) +
      `${OMX_GENERATED_AGENTS_MARKER}${lineEnding}` +
      content.slice(insertionPoint)
    )
  }

  const firstNewline = content.indexOf('\n')
  if (firstNewline === -1) {
    return `${content}\n${OMX_GENERATED_AGENTS_MARKER}\n`
  }

  return (
    content.slice(0, firstNewline + 1) +
    `${OMX_GENERATED_AGENTS_MARKER}\n` +
    content.slice(firstNewline + 1)
  )
}
