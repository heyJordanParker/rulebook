import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Finding, CheckedFile } from './api.ts'
import { isRecord } from './config.ts'
import type { AgenticRule } from './rules.ts'

const PLUGIN = 'rulebook-rule'
const SKILL = 'check'

const SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { line: { type: 'integer' }, message: { type: 'string' } },
        required: ['line', 'message'],
      },
    },
  },
  required: ['findings'],
}

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

function claudeProgram(): string {
  const program = Bun.which('claude', { PATH: process.env.PATH ?? '' })
  if (!program) throw new Error('rulebook runs agentic rules with Claude Code, and finds no claude on PATH.')
  return program
}

function sessionArguments(plugin: string): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--json-schema', JSON.stringify(SCHEMA),
    '--no-session-persistence',
    '--permission-prompts', 'none',
    '--settings', JSON.stringify({ disableAllHooks: true }),
    '--plugin-dir', plugin,
    '--model', 'haiku',
    '--disallowedTools', ...WRITE_TOOLS,
  ]
}

function ruleSkill(rule: AgenticRule, file: CheckedFile, changed: readonly number[] | undefined): string {
  const list = (tools: string | readonly string[] | undefined): string[] => (tools === undefined ? [] : typeof tools === 'string' ? tools.split(/[\s,]+/).filter((tool) => tool !== '') : [...tools])
  const allowed = list(rule.allowedTools)
  const frontmatter = {
    name: SKILL,
    description: rule.description,
    context: 'fork',
    ...(rule.agent === undefined ? {} : { agent: rule.agent }),
    ...(rule.model === undefined ? {} : { model: rule.model }),
    ...(rule.effort === undefined ? {} : { effort: rule.effort }),
    ...(allowed.length === 0 ? {} : { 'allowed-tools': allowed }),
    'disallowed-tools': [...WRITE_TOOLS, ...list(rule.disallowedTools)],
  }
  const width = String(file.lines.length).length
  const numbered = file.lines.map((line, index) => `${String(index + 1).padStart(width)} | ${line}`).join('\n')
  const edit = changed === undefined ? '' : `\n\nThis is the file as an edit will leave it. The edit wrote lines ${changed.length === 0 ? '(none, it only removed lines)' : changed.join(', ')}.`
  return `---
${JSON.stringify(frontmatter)}
---

${rule.body}

---

Check the file \`${file.path}\` against the rule above. Its lines, numbered:

${numbered}${edit}

Answer only with a JSON object of the form {"findings": [{"line": <number>, "message": "<what the author changes>"}]}: one finding per line that breaks the rule. A line that follows the rule gets no finding, so never write a finding that says a line is fine. When every line follows the rule, answer {"findings": []}. Change no file.`
}

export async function runAgentic(rule: AgenticRule, file: CheckedFile, root: string, changed: readonly number[] | undefined, deadline: AbortSignal): Promise<readonly Finding[]> {
  const plugin = mkdtempSync(join(tmpdir(), 'rulebook-rule-'))
  try {
    mkdirSync(join(plugin, '.claude-plugin'))
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN, version: '0.0.0', description: `Runs ${rule.id} for rulebook.` }))
    mkdirSync(join(plugin, 'skills', SKILL), { recursive: true })
    writeFileSync(join(plugin, 'skills', SKILL, 'SKILL.md'), ruleSkill(rule, file, changed))
    return await runSession(plugin, root, deadline)
  } finally {
    rmSync(plugin, { recursive: true, force: true })
  }
}

async function runSession(plugin: string, root: string, deadline: AbortSignal): Promise<readonly Finding[]> {
  deadline.throwIfAborted()
  const child = Bun.spawn([claudeProgram(), ...sessionArguments(plugin)], {
    cwd: root,
    env: process.env,
    stdin: new Blob([`/${PLUGIN}:${SKILL}`]),
    stdout: 'pipe',
    stderr: 'pipe',
    signal: deadline,
  })
  const passed = new Promise<never>((_, reject) => deadline.addEventListener('abort', () => reject(deadline.reason), { once: true }))
  const finished = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const [stdout, stderr, exitCode] = await Promise.race([finished, passed])
  if (exitCode !== 0 && stdout.trim() === '') throw new Error(`claude exited ${exitCode}: ${lastLine(stderr)}`)
  return findingsOf(stdout)
}

function findingsOf(stdout: string): readonly Finding[] {
  const events: unknown[] = stdout.trim().split('\n').map((line) => JSON.parse(line))
  const answer = events.at(-1)
  if (!isRecord(answer) || answer.type !== 'result') throw new Error('claude answered no result event')
  if (answer.is_error === true) throw new Error(`claude failed: ${String(answer.result ?? answer.subtype ?? 'no reason')}`)
  const structured = structuredOutputOf(events) ?? parsedResult(answer.result)
  if (!isRecord(structured) || !Array.isArray(structured.findings)) throw new Error(`claude answered no findings: ${String(answer.result ?? '').slice(0, 200)}`)
  return structured.findings.map((finding: unknown) => {
    if (!isRecord(finding) || !Number.isInteger(finding.line) || typeof finding.message !== 'string') throw new Error(`claude answered a finding without a line and a message: ${JSON.stringify(finding)}`)
    return { line: finding.line as number, message: finding.message }
  })
}

function structuredOutputOf(events: readonly unknown[]): unknown {
  const answers = events.flatMap((event) => {
    if (!isRecord(event)) return []
    if (event.type === 'result' && isRecord(event.structured_output)) return [event.structured_output]
    const content = isRecord(event.message) && Array.isArray(event.message.content) ? event.message.content : []
    return content.filter((block: unknown) => isRecord(block) && block.type === 'tool_use' && block.name === 'StructuredOutput').map((block: Record<string, unknown>) => block.input)
  })
  return answers.at(-1)
}

function parsedResult(result: unknown): unknown {
  if (typeof result !== 'string') return undefined
  const json = /\{[\s\S]*\}/.exec(result)?.[0]
  if (json === undefined) return undefined
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? ''
}
