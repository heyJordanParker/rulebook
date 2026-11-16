import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Call } from './api.ts'
import { checkFile } from './check.ts'
import { isClaudeMd } from './claude-md.ts'
import { existingFolder, isRecord, loadSettings, projectRoot } from './config.ts'
import { loadImportedFiles, watchImportSource } from './files.ts'
import { editAnswer, type EditAnswer } from './report.ts'
import { loadRules } from './rules.ts'

type Replacement = { readonly old_string: string; readonly new_string: string; readonly replace_all?: boolean }

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])

const PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m

export function editRoot(call: Call): string {
  const path = editedPath(call)
  return path === undefined ? projectRoot(call.cwd, call.cwd) : fileRoot(realFile(path, call.cwd), call.cwd)
}

export function realFile(path: string, cwd: string): string {
  const file = isAbsolute(path) ? path : resolve(cwd, path)
  const nearest = existingFolder(file)
  return join(realpathSync(nearest), relative(nearest, file))
}

export function fileRoot(file: string, cwd: string): string {
  const folder = existingFolder(dirname(file))
  return projectRoot(folder, file.startsWith(`${realpathSync(cwd)}/`) ? cwd : folder)
}

export async function checkEdit(call: Call, root: string): Promise<EditAnswer> {
  const path = editedPath(call)
  if (path === undefined) return editAnswer(undefined)
  const file = realFile(path, call.cwd)
  const previous = existsSync(file) ? await Bun.file(file).text() : undefined
  const next = editedText(call.tool, call.input, previous) ?? ''
  if (isClaudeMd(file)) watchImportSource(file)
  const settings = await loadSettings(dirname(file), root)
  const { rules } = await loadRules(settings)
  const isWhole = next === ''
  const report = await checkFile(settings, rules, file, next, { scope: 'edit', previous: isWhole ? '' : previous ?? '', imported: () => loadImportedFiles(root), call })
  return editAnswer(report)
}

function editedPath({ tool, input }: Call): string | undefined {
  const path = input.file_path ?? input.notebook_path
  if (typeof path === 'string') return path
  if (tool !== 'apply_patch') return undefined
  const patch = [input.command, input.input, input.patch].find((text) => typeof text === 'string' && text.includes('*** '))
  return typeof patch === 'string' ? PATCH_FILE.exec(patch)?.[1]?.trim() : undefined
}

function editedText(tool: string, input: Readonly<Record<string, unknown>>, previous: string | undefined): string | undefined {
  if (tool === 'Write') return typeof input.content === 'string' ? input.content : undefined
  if (previous === undefined) return undefined
  if (tool === 'Edit') return replaced(previous, [input])
  if (tool === 'MultiEdit') return Array.isArray(input.edits) ? replaced(previous, input.edits) : undefined
  return undefined
}

function replaced(text: string, edits: readonly unknown[]): string | undefined {
  let result = text
  for (const edit of edits) {
    if (!isReplacement(edit) || !result.includes(edit.old_string)) return undefined
    result = edit.replace_all === true ? result.replaceAll(edit.old_string, edit.new_string) : result.replace(edit.old_string, () => edit.new_string)
  }
  return result
}

function isReplacement(value: unknown): value is Replacement {
  return isRecord(value) && typeof value.old_string === 'string' && typeof value.new_string === 'string'
}
