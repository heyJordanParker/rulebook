import { join } from 'node:path'
import type { Finding, PromptFile } from './api.ts'
import { isRecord } from './config.ts'
import type { AgenticRule } from './rules.ts'

const API = 'https://api.typesafe.ai'
const MODEL = 'jev-latest'
const THRESHOLD = 0.7
const WINDOW = 120_000

let storedKey: Promise<string> | undefined

export function isJev(model: unknown): boolean {
  return model === 'jev'
}

export async function runJev(rule: AgenticRule, file: PromptFile, deadline: AbortSignal): Promise<readonly Finding[]> {
  const key = await jevKey()
  if (key === '') throw new Error(`${rule.id} runs on Jev, and rulebook has no Jev key. Store your TypeSafe API key with \`cmod secret store rulebook jev\`, which reads it on stdin.`)
  const width = String(file.lines.length).length
  const windows: { lines: string[]; asked: number[]; size: number }[] = []
  file.lines.forEach((text, index) => {
    const numbered = `${String(index + 1).padStart(width)} | ${text}`
    const asks = text.trim() !== ''
    const size = numbered.length + (asks ? 200 : 0)
    const last = windows.at(-1)
    const window = last !== undefined && last.size + size <= WINDOW ? last : { lines: [], asked: [], size: 0 }
    if (window !== last) windows.push(window)
    window.lines.push(numbered)
    if (asks) window.asked.push(index + 1)
    window.size += size
  })
  const found = await Promise.all(windows.filter(({ asked }) => asked.length > 0).map((window) => flagged(rule, file.path, window, key, deadline)))
  return found.flat()
}

async function jevKey(): Promise<string> {
  storedKey ??= readKey()
  const key = await storedKey.catch((error: unknown) => {
    storedKey = undefined
    throw error
  })
  if (key === '') storedKey = undefined
  return key
}

async function readKey(): Promise<string> {
  const cmod = join(process.env.XDG_DATA_HOME || join(process.env.HOME ?? '', '.local', 'share'), 'cmod', 'programs', 'cmod')
  if (!(await Bun.file(cmod).exists())) return ''
  const read = Bun.spawn([cmod, 'secret', 'get', 'rulebook', 'jev'], { env: process.env, stdout: 'pipe', stderr: 'pipe' })
  const [key, error, code] = await Promise.all([new Response(read.stdout).text(), new Response(read.stderr).text(), read.exited])
  if (code !== 0) throw new Error(`cmod secret get rulebook jev failed: ${error.trim()}`)
  return key
}

async function flagged(rule: AgenticRule, path: string, { lines, asked }: { readonly lines: readonly string[]; readonly asked: readonly number[] }, key: string, deadline: AbortSignal): Promise<readonly Finding[]> {
  const response = await fetch(`${(process.env.JEV_BASE_URL || API).replace(/\/+$/, '')}/v1/systemone`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      state: { rule: `${rule.description}\n\n${rule.body}`, file: path, lines: lines.join('\n') },
      questions: Object.fromEntries(asked.map((line) => [`line_${line}`, {
        type: 'noul',
        instructions: `Line ${line} of the file follows the rule.`,
        criteria: { true: `Line ${line} follows the rule, or the rule does not apply to it.`, false: `Line ${line} breaks the rule.` },
      }])),
    }),
    signal: deadline,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Jev answered ${response.status}: ${text.slice(0, 300)}`)
  const answer: unknown = JSON.parse(text)
  const answers = isRecord(answer) && isRecord(answer.answers) ? answer.answers : {}
  return asked.flatMap((line) => {
    const noul = answers[`line_${line}`]
    if (!isRecord(noul) || typeof noul.noul !== 'number') throw new Error(`Jev answered no noul for line ${line}`)
    return noul.noul >= (rule.threshold ?? THRESHOLD) ? [] : [{ line }]
  })
}
