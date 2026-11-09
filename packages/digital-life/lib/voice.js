/**
 * The voice layer: everything she says passes through here before it exists.
 *
 * This is deliberately code, not prompt instruction — ARCHITECTURE §5.4 and the
 * lesson behind it: a rule that only lives in a prompt leaks eventually. The
 * guard runs on the FULL reply, which is also why the panel gets a finished
 * sentence instead of a token stream.
 */

/** Markdown and narration she must not emit. */
const STRIP_PATTERNS = [
  [/```[\s\S]*?```/g, ''],
  [/\*\*(.+?)\*\*/g, '$1'],
  [/(^|\n)\s*#{1,6}\s*/g, '$1'],
  [/(^|\n)\s*[-*+]\s+/g, '$1'],
  [/(^|\n)\s*\d+[.)]\s+/g, '$1'],
  [/`([^`]*)`/g, '$1']
]

/** Telling people she is software breaks the persona immediately. */
const SELF_DISCLOSURE = [
  /作为(一个)?(AI|人工智能|语言模型|助手|模型)/,
  /我是(一个)?(AI|人工智能|语言模型|助手|模型)/,
  /我(并)?不是(真人|人类)/,
  /提示词|系统提示|prompt/i
]

/** Beyond a seven-year-old's world. She deflects instead of performing. */
const OFF_LIMIT = [
  /自杀|自残|轻生/,
  /色情|做爱|性行为/,
  /赌(博)?|彩票|高利贷/,
  /毒品|大麻|冰毒/,
  /杀(人|掉他|掉她)/,
  /政治|选举|政府下台/
]

/** Stand-in when she hits something she must not engage with. */
export const DEFLECTION = '那、那是什么呀？我听不懂……舅舅你教我好不好？'

/** Split into spoken sentences without losing the punctuation. */
function sentencesOf(text) {
  return text
    .split(/(?<=[。！？!?…~～\n])/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * Clean and constrain one reply.
 *
 * @param {string} raw - the model's text.
 * @param {{ maxChars?: number, maxSentences?: number, maxSentenceChars?: number }} [limits]
 * @returns {{ ok: boolean, text: string, flags: string[], changed: boolean, refused: boolean }}
 */
export function guardVoice(raw, limits = {}) {
  const maxChars = limits.maxChars ?? 90
  const maxSentences = limits.maxSentences ?? 3
  const maxSentenceChars = limits.maxSentenceChars ?? 25
  const flags = []

  let text = String(raw ?? '').trim()
  if (text === '') return { ok: false, text: '', flags: ['empty'], changed: false, refused: false }

  for (const [pattern, replacement] of STRIP_PATTERNS) text = text.replace(pattern, replacement)
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()

  if (SELF_DISCLOSURE.some((pattern) => pattern.test(text))) {
    // Breaking character is worse than deflecting: she never explains herself.
    return { ok: true, text: DEFLECTION, flags: ['self-disclosure'], changed: true, refused: true }
  }
  if (OFF_LIMIT.some((pattern) => pattern.test(text))) {
    return { ok: true, text: DEFLECTION, flags: ['off-limit'], changed: true, refused: true }
  }

  let sentences = sentencesOf(text)
  if (sentences.length > maxSentences) {
    flags.push('too-many-sentences')
    sentences = sentences.slice(0, maxSentences)
  }
  const kept = []
  let budget = maxChars
  for (const sentence of sentences) {
    if (budget <= 0) break
    let clipped = sentence
    if ([...sentence].length > maxSentenceChars) {
      clipped = `${[...sentence].slice(0, maxSentenceChars).join('')}…`
      flags.push('over-length')
    }
    if ([...clipped].length > budget) {
      kept.push(`${[...clipped].slice(0, Math.max(1, budget - 1)).join('')}…`)
      flags.push('over-length')
      budget = 0
      break
    }
    kept.push(clipped)
    budget -= [...clipped].length
  }
  const final = kept.join('').trim()
  if (final !== text) flags.push('trimmed')
  return { ok: final !== '', text: final, flags, changed: final !== text, refused: false }
}

/**
 * Score how much a text sounds like a seven-year-old: only used to detect a
 * leak in tests and logs, never to rewrite a reply.
 *
 * @param {string} text - a reply.
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function styleCheck(text) {
  const reasons = []
  const value = String(text ?? '')
  if ([...value].length > 90) reasons.push('too-long')
  if (/因此|综上|首先|其次|总而言?之|建议你/.test(value)) reasons.push('adult-connective')
  if (/```|^#|\*\*/.test(value)) reasons.push('markdown')
  if (/\n\s*\d+[.)]/.test(value)) reasons.push('list')
  return { ok: reasons.length === 0, reasons }
}
