import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isPrompt } from './check.ts'
import { claudeJsonFile, importedFile, isClaudeMd, isRulesFolder, readClaudeMd, userMemoryPaths } from './claude-md.ts'
import { isInside, isRecord, loadSettings, type Settings } from './config.ts'

const IMPORT_HOPS = 4

const loadedImports = new Map<string, Promise<ReadonlySet<string>>>()
const importPaths = new Set<string>()

export function importSources(): readonly string[] {
  return [...importPaths]
}

export function watchImportSource(file: string): void {
  importPaths.add(file)
}

export function loadImportedFiles(root: string): Promise<ReadonlySet<string>> {
  const known = loadedImports.get(root)
  if (known !== undefined) return known
  const imported = loadSettings(root, root).then(async (settings) => {
    const candidates = projectFiles(settings, await listedFiles(root)).filter((file) => isClaudeMd(file) || isRulesLink(file))
    return importedFiles(root, await filesBySettings(root, candidates))
  })
  loadedImports.set(root, imported)
  return imported
}

export async function filesBySettings(root: string, files: readonly string[]): Promise<ReadonlyMap<Settings, readonly string[]>> {
  const groups = new Map<Settings, string[]>()
  for (const file of files) {
    const settings = await loadSettings(dirname(file), root)
    const group = groups.get(settings) ?? []
    group.push(file)
    groups.set(settings, group)
  }
  return groups
}

export function importedFiles(root: string, groups: ReadonlyMap<Settings, readonly string[]>): ReadonlySet<string> {
  const userPaths = userMemoryPaths()
  const isUserMemory = (file: string): boolean => userPaths.some((path) => isInside(path, file))
  let isApproved: boolean | undefined
  const reaches = (isUser: boolean, target: string, real: string): boolean => isUser || (isInside(root, target) && isInside(root, real)) || (isApproved ??= externalImportsApproved(root))
  const claudeMds = [...groups].flatMap(([settings, files]) => files.filter((file) => isPrompt(settings, file) && isClaudeMd(file) && existsSync(file)))
  const links = [...groups].flatMap(([settings, files]) => files.filter(isRulesLink).map((link) => ({ settings, link })))
  for (const { link } of links) importPaths.add(link)
  const linked = new Set(links
    .flatMap(({ settings, link }) => [...new Bun.Glob('**/*.md').scanSync({ cwd: link, absolute: true, dot: true, followSymlinks: true })].filter((file) => isPrompt(settings, file)))
    .map((file) => ({ file, real: realpathSync(file) }))
    .filter(({ file, real }) => reaches(isUserMemory(real), file, real))
    .map(({ real }) => real))
  const roots = new Set([...claudeMds, ...linked])
  const queue = [...roots].map((file) => ({ file, hops: 0, isUser: isUserMemory(file) }))
  const seen = new Set(queue.map(({ file }) => realpathSync(file)))
  for (const { file, hops, isUser } of queue) {
    importPaths.add(file)
    if (hops === IMPORT_HOPS) continue
    for (const { path } of readClaudeMd(readFileSync(file, 'utf8')).imports) {
      const target = importedFile(file, path)
      if (target === undefined) continue
      importPaths.add(target)
      if (statSync(target, { throwIfNoEntry: false })?.isFile() !== true) continue
      const real = realpathSync(target)
      if (seen.has(real) || !reaches(isUser, target, real)) continue
      seen.add(real)
      queue.push({ file: real, hops: hops + 1, isUser })
    }
  }
  return new Set([...linked, ...queue.filter(({ hops }) => hops > 0).map(({ file }) => file)])
}

function isRulesLink(entry: string): boolean {
  return statSync(entry, { throwIfNoEntry: false })?.isDirectory() === true && isRulesFolder(entry)
}

export function ruleTestFiles(settings: Settings): readonly string[] {
  const ruleTests = settings.configs.flatMap((config) => config.tests.flatMap((glob) => [...new Bun.Glob(glob).scanSync({ cwd: config.dir, absolute: true, dot: true })]))
  return [...new Set(ruleTests.map((file) => realpathSync(file)))].filter((file) => isInside(settings.root, file)).sort()
}

export async function listedFiles(folder: string): Promise<readonly string[] | undefined> {
  const git = Bun.spawn(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--full-name', '--', ':/'], { cwd: folder, stdout: 'pipe', stderr: 'ignore' })
  const [listed, exitCode] = await Promise.all([new Response(git.stdout).text(), git.exited])
  return exitCode === 0 ? listed.split('\0').filter((path) => path !== '') : undefined
}

export function projectFiles(settings: Settings, listed: readonly string[] | undefined): readonly string[] {
  const candidates = listed === undefined
    ? settings.files.flatMap((glob) => [...new Bun.Glob(glob).scanSync({ cwd: settings.root, absolute: true, dot: true })])
    : listed.map((path) => join(settings.root, path))
  return [...new Set(candidates)].sort()
}

function externalImportsApproved(root: string): boolean {
  const file = claudeJsonFile()
  if (!existsSync(file)) return false
  const config: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const project = isRecord(config) && isRecord(config.projects) ? config.projects[root] : undefined
  return isRecord(project) && project.hasClaudeMdExternalIncludesApproved === true
}
