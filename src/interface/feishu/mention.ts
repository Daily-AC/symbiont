export interface MentionInfo {
  userId: string
  name: string
}

export function isMentioningBot(mentions: MentionInfo[] | undefined, botId: string): boolean {
  if (!mentions || mentions.length === 0) return false
  return mentions.some(m => m.userId === botId)
}

export function removeBotMention(text: string, botName: string): string {
  return text.replace(new RegExp(`@${botName}\\s*`, 'g'), '').trim()
}
