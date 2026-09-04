import { loadConfig } from './config'
import { buildApp } from './app'

async function main(): Promise<void> {
  const config = loadConfig()
  const app = buildApp(config)

  const shutdown = async (): Promise<void> => {
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  await app.listen({ host: config.host, port: config.port })

  // The token travels in the URL fragment: browsers never send a fragment to a
  // server, so it stays out of request logs, Referer headers and history sync.
  // This banner is the operator's copy; nothing logs it.
  process.stdout.write(
    [
      '',
      '  FDE Control Center — read-only console',
      `  runs      ${config.runsRoot}`,
      `  projects  ${config.projectsRoot}`,
      `  open      http://${config.host}:${config.port}/#token=${config.token}`,
      '',
      '  Loopback only. The link above is valid for this launch alone.',
      '',
    ].join('\n'),
  )
}

main().catch((error: unknown) => {
  process.stderr.write(`fde-gui: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
