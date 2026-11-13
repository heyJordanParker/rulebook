import { rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRecord, isStrings } from './config.ts'
import { isQuestion, projectOf, type Question } from './questions.ts'
import type { Answered, Asked } from './worker.ts'

const ENVIRONMENT = ['CLAUDE_CONFIG_DIR', 'HOME', 'JEV_BASE_URL', 'PATH', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME']
const IDLE_MS = 15 * 60_000
const WORKER = new URL(Bun.isStandaloneExecutable ? './src/worker.ts' : './worker.ts', import.meta.url)

type Environment = Readonly<Record<string, string>>

type Project = {
  readonly worker: Worker
  readonly startedAt: number
  readonly watched: Map<string, boolean>
  readonly asking: Map<number, PromiseWithResolvers<unknown>>
  isRetired: boolean
  idle: Timer | undefined
}

export async function serve(): Promise<never> {
  const socket = join(tmpdir(), `rulebook-${process.pid}.sock`)
  const projects = new Map<string, Project>()
  const failing = new Map<string, readonly string[]>()
  const shown = new Set<string>()
  let lastId = 0

  const stop = (project: Project): void => {
    project.isRetired = true
    clearTimeout(project.idle)
    if (project.asking.size === 0) project.worker.terminate()
  }

  const fail = (key: string, project: Project, reason: string): void => {
    for (const asked of project.asking.values()) asked.reject(new Error(reason))
    project.asking.clear()
    if (projects.get(key) === project) projects.delete(key)
    stop(project)
  }

  const started = (key: string, root: string, environment: Environment): Project => {
    const env = { ...Object.fromEntries(Object.entries(process.env).flatMap(([name, value]) => (value === undefined || ENVIRONMENT.includes(name) ? [] : [[name, value]]))), ...environment }
    const project: Project = { worker: new Worker(WORKER, { env }), startedAt: Date.now(), watched: new Map(), asking: new Map(), isRetired: false, idle: undefined }
    project.worker.onmessage = ({ data }: MessageEvent<Answered>) => {
      for (const path of data.watched) if (!project.watched.has(path)) project.watched.set(path, statSync(path, { throwIfNoEntry: false }) !== undefined)
      const asked = project.asking.get(data.id)
      project.asking.delete(data.id)
      if ('error' in data) asked?.reject(new Error(data.error))
      else asked?.resolve(data.answer)
      if (project.asking.size > 0) return
      if (project.isRetired) project.worker.terminate()
      else project.idle = setTimeout(() => (projects.get(key) === project ? (projects.delete(key), stop(project)) : undefined), IDLE_MS)
    }
    project.worker.onerror = (event) => fail(key, project, `the worker for ${root} failed: ${event.message}`)
    project.worker.addEventListener('close', () => fail(key, project, `the worker for ${root} stopped`))
    return project
  }

  const projectFor = (key: string, root: string, environment: Environment): Project => {
    const known = projects.get(key)
    if (known !== undefined && !isStale(known)) return known
    if (known !== undefined) stop(known)
    const project = started(key, root, environment)
    projects.set(key, project)
    return project
  }

  const unshown = (key: string, listing: unknown): unknown => {
    if (!isRecord(listing) || !isStrings(listing.failures)) return listing
    const { failures } = listing
    for (const fixed of failing.get(key) ?? []) if (!failures.includes(fixed)) shown.delete(fixed)
    failing.set(key, failures)
    const fresh = failures.filter((failure) => !shown.has(failure))
    for (const failure of fresh) shown.add(failure)
    return { ...listing, failures: fresh }
  }

  const ask = (project: Project, question: Question, input: unknown, root: string): Promise<unknown> => {
    lastId += 1
    const asked = Promise.withResolvers<unknown>()
    project.asking.set(lastId, asked)
    clearTimeout(project.idle)
    project.worker.postMessage({ id: lastId, question, input, root } satisfies Asked)
    return asked.promise
  }

  const server = Bun.serve({
    unix: socket,
    idleTimeout: 0,
    async fetch(request: Request) {
      const question = new URL(request.url).pathname.slice(1)
      if (request.method !== 'POST' || !isQuestion(question)) return new Response('The rulebook server answers POST /edit, /text, and /rules.', { status: 404 })
      try {
        const body: unknown = await request.json()
        if (!isRecord(body)) throw new Error('The rulebook server reads {"input", "environment"}.')
        const root = projectOf(question, body.input)
        const environment = environmentOf(body.environment)
        const key = `${root}\0${JSON.stringify(environment)}`
        const answered = await ask(projectFor(key, root, environment), question, body.input, root)
        return Response.json(question === 'rules' ? unshown(key, answered) : answered)
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 500 })
      }
    },
  } as unknown as Bun.Serve.Options<undefined>)

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      void server.stop(true)
      rmSync(socket, { force: true })
      process.exit(0)
    })
  }
  await Bun.write(Bun.stdout, `unix:${socket}\n`)
  return new Promise<never>(() => undefined)
}

function isStale({ watched, startedAt }: Project): boolean {
  for (const [path, existed] of watched) {
    const stats = statSync(path, { throwIfNoEntry: false })
    if ((stats !== undefined) !== existed || (stats !== undefined && stats.ctimeMs >= startedAt)) return true
  }
  return false
}

function environmentOf(sent: unknown): Environment {
  if (!isRecord(sent)) throw new Error('The rulebook server reads {"input", "environment"}.')
  return Object.fromEntries(ENVIRONMENT.flatMap((name) => (typeof sent[name] === 'string' ? [[name, sent[name]]] : [])))
}
