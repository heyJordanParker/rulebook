import { answer, isQuestion, projectOf } from '../src/questions.ts'

const [question = ''] = Bun.argv.slice(2)
if (!isQuestion(question)) throw new Error(`${question} is not a question.`)
const input: unknown = JSON.parse(await Bun.stdin.text())
await Bun.write(Bun.stdout, `${JSON.stringify(await answer(question, input, projectOf(question, input)))}\n`)
process.exit(0)
