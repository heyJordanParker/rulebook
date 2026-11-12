import type { PageInit } from '../../node_modules/@cmodjs/core/mod.js'
import { Box, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import type { RulebookState, Report } from '../state.js'

export const resultsPage: PageInit<RulebookState> = {
  id: 'results',
  title: 'rulebook',
  render: (mod) => {
    const { run } = mod.state.memory
    if (run.status === 'idle') return <Text dimColor>Run /rulebook to check every Prompt in this project.</Text>
    if (run.status === 'running') return <Text dimColor>{run.files.length === 0 ? 'Checking every Prompt in this project with every rule…' : `Checking ${run.files.join(', ')} with every rule…`}</Text>
    if (run.status === 'failed') return <Text>{`rulebook failed: ${run.error}`}</Text>
    return <Results reports={run.reports} failures={run.failures} />
  },
}

function Results({ reports, failures }: { readonly reports: readonly Report[]; readonly failures: readonly string[] }): JSX.Element {
  const findings = reports.flatMap((report) => report.findings)
  const errors = findings.filter(({ level }) => level === 'error').length
  const flagged = reports.filter((report) => report.findings.length > 0 || report.failures.length > 0)
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{`${errors} ${errors === 1 ? 'error' : 'errors'}, ${findings.length - errors} ${findings.length - errors === 1 ? 'warning' : 'warnings'} in ${reports.length} ${reports.length === 1 ? 'file' : 'files'}`}</Text>
      {failures.map((failure) => (
        <Text key={failure} wrap="wrap">{failure}</Text>
      ))}
      {flagged.map((report) => (
        <Box key={report.path} flexDirection="column">
          <Text bold>{report.path}</Text>
          {report.findings.map((finding) => (
            <Text key={`${finding.rule}:${finding.line}`} wrap="wrap">
              {`  ${finding.line}  ${finding.level}  ${finding.rule}  ${finding.message}`}
            </Text>
          ))}
          {report.failures.map((failure) => (
            <Text key={`failure:${failure.rule}`} dimColor wrap="wrap">{`  ${failure.rule} did not run: ${failure.reason}`}</Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}
