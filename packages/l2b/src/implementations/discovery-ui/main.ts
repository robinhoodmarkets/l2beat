import {
  ConfigHealthService,
  ConfigReader,
  ConfigWriter,
  getDiscoveryPaths,
  TemplateService,
  UserHandlers,
} from '@l2beat/discovery'
import { DiffHistoryParser } from '@l2beat/shared'
import { ChainSpecificAddress } from '@l2beat/shared-pure'
import { toJsonSchema, v as z } from '@l2beat/validate'
import { config as dotenv } from 'dotenv'
import express from 'express'
import { existsSync, readFileSync } from 'fs'
import type { Server } from 'http'
import path, { join } from 'path'
import { getCodePaths } from '../discovery/getCodePaths'
import { attachAnalyzeRouter } from './analyze/router'
import { attachConfigRouter } from './configs/router'
import { DiffoveryController } from './diffovery/DiffoveryController'
import { FlatSourceClient } from './diffovery/FlatSourceClient'
import { attachDiffoveryRouter } from './diffovery/router'
import { executeTerminalCommand } from './executeTerminalCommand'
import {
  getCodeFromDisk,
  getCodeFromEtherscan,
  toCodeDeclarations,
} from './getCode'
import { getConfigHealth } from './getConfigHealth'
import { getPreview } from './getPreview'
import { getProject } from './getProject'
import { getProjects } from './getProjects'
import { attachLayoutRouter } from './layouts/router'
import { searchCode } from './searchCode'
import {
  attachTemplateRouter,
  listTemplateFilesSchema,
} from './templates/router'

const safeStringSchema = z
  .string()
  .check(
    (v) => v.length > 0 && /^[a-zA-Z0-9_-]+$/.test(v),
    'Input cannot be empty and must be alphanumeric and can contain underscores or hyphens.',
  )

const ethereumAddressSchema = z.string().transform(ChainSpecificAddress)

export const projectParamsSchema = z.object({
  project: safeStringSchema,
})

const projectQuerySchema = z.object({
  maxDepth: z
    .string()
    .check((v) => /^\d+$/.test(v), 'maxDepth must be a non-negative integer')
    .transform((v) => Number(v))
    .optional(),
})

const projectAddressParamsSchema = z.object({
  project: safeStringSchema,
  address: ethereumAddressSchema,
})

const projectSearchTermParamsSchema = z.object({
  project: safeStringSchema,
  searchTerm: z.string(),
  address: ethereumAddressSchema.optional(),
})

const discoverQuerySchema = z.object({
  project: safeStringSchema,
  devMode: z.enum(['true', 'false']).transform((val) => val === 'true'),
})

const matchFlatQuerySchema = z.object({
  project: safeStringSchema,
  address: ethereumAddressSchema,
  against: z.enum(['templates', 'projects']),
})

const findMintersSchema = z.object({
  address: ethereumAddressSchema,
})

const nonNegativeIntFromString = z
  .string()
  .check((v) => /^\d+$/.test(v), 'must be a non-negative integer')
  .transform((v) => Number(v))

const positiveIntFromString = z
  .string()
  .check((v) => /^\d+$/.test(v) && Number(v) > 0, 'must be a positive integer')
  .transform((v) => Number(v))

const diffHistoryQuerySchema = z.object({
  offset: nonNegativeIntFromString.optional(),
  limit: positiveIntFromString.optional(),
})

export function runDiscoveryUi({ readonly }: { readonly: boolean }) {
  dotenv()
  const app = express()
  // Number() is required by the host binding added at the bottom of this
  // function, not cosmetic. process.env.PORT is a string when set, so this
  // expression is `string | number`, and @types/express-serve-static-core@5.0.1
  // declares (index.d.ts:1241-1246):
  //
  //   listen(port: number, hostname: string, backlog: number, cb?): Server
  //   listen(port: number, hostname: string, cb?): Server
  //   listen(port: number, cb?): Server
  //   listen(cb?): Server
  //   listen(path: string, cb?): Server
  //   listen(handle: any, listeningListener?): Server
  //
  // The previous two-argument `app.listen(port, cb)` call typechecked only
  // because `string | number` fell through to the last overload, where the first
  // parameter is `any`. There is no such escape hatch in the three-argument
  // form, so passing the union straight through fails with TS2769.
  //
  // Coercing here rather than at the call site keeps the log line below and the
  // bind in agreement. A numeric PORT behaves exactly as before; a non-numeric
  // one becomes NaN, which node rejects with ERR_SOCKET_BAD_PORT instead of
  // being reinterpreted as a pipe path by the `listen(path: string, cb?)`
  // overload.
  const port = Number(process.env.PORT ?? 2021)

  const STATIC_ROOT = join(__dirname, '../../../../protocolbeat/build')

  const paths = getDiscoveryPaths()
  const configReader = new ConfigReader(paths.discovery)
  const configWriter = new ConfigWriter(configReader, paths.discovery)
  const templateService = new TemplateService(paths.discovery)
  const configHealthService = new ConfigHealthService()

  const diffHistoryParser = new DiffHistoryParser()
  const flatSourceClient = new FlatSourceClient()
  const diffoveryController = new DiffoveryController(flatSourceClient)

  app.use(express.json())

  app.get('/health', (_, res) => {
    res.status(200).send('OK')
  })

  app.get('/api/projects', (_req, res) => {
    const response = getProjects(configReader)
    res.json(response)
  })

  app.get('/api/projects/:project', (req, res) => {
    const paramsValidation = projectParamsSchema.safeParse(req.params)
    if (!paramsValidation.success) {
      res.status(400).json({ errors: paramsValidation.message })
      return
    }
    const queryValidation = projectQuerySchema.safeParse(req.query)
    if (!queryValidation.success) {
      res.status(400).json({ errors: queryValidation.message })
      return
    }
    const { project } = paramsValidation.data
    const { maxDepth } = queryValidation.data

    const response = getProject(
      configReader,
      templateService,
      project,
      maxDepth,
    )
    res.json(response)
  })

  app.get('/api/projects/:project/preview', (req, res) => {
    const paramsValidation = projectParamsSchema.safeParse(req.params)
    if (!paramsValidation.success) {
      res.status(400).json({ errors: paramsValidation.message })
      return
    }
    const { project } = paramsValidation.data

    const response = getPreview(configReader, project)
    res.json(response)
  })

  app.get('/api/projects/:project/code/:address', async (req, res) => {
    const paramsValidation = projectAddressParamsSchema.safeParse(req.params)
    if (!paramsValidation.success) {
      res.status(400).json({ errors: paramsValidation.message })
      return
    }
    const { project, address } = paramsValidation.data

    const isLocal = readonly === false
    try {
      const response = isLocal
        ? getCodeFromDisk(configReader, project, address)
        : await getCodeFromEtherscan(
            configReader,
            project,
            address,
            flatSourceClient,
          )
      res.json(toCodeDeclarations(response))
    } catch (e) {
      console.error(e)
      res.status(500).json({ error: 'Failed to fetch code' })
    }
  })

  app.get('/api/template-files', (req, res) => {
    const query = listTemplateFilesSchema.safeParse(req.query)

    if (!query.success) {
      res.status(400).json({ errors: query.message })
      return
    }

    const template = templateService.readTemplateFile(query.data.templateId)

    if (!template) {
      res.status(404).json({ error: 'Template not found' })
      return
    }

    const shapes = templateService.readShapeFile(query.data.templateId)
    const criteria = templateService.readCriteriaFile(query.data.templateId)

    res.json({
      template,
      shapes,
      criteria,
    })
  })

  app.get('/api/config/sync-status/:project', (req, res) => {
    const query = projectParamsSchema.safeParse(req.params)
    if (!query.success) {
      res.status(400).json({ errors: query.message })
      return
    }
    const { project } = query.data

    templateService.reload()

    const discovery = configReader.readDiscovery(project)
    const config = configReader.readConfig(project)

    res.json({
      reasons: templateService.discoveryNeedsRefresh(discovery, config),
    })
  })

  app.get('/api/config-files/:project', (req, res) => {
    const query = projectParamsSchema.safeParse(req.params)

    if (!query.success) {
      res.status(400).json({ errors: query.message })
      return
    }

    const configText = configReader.readRawConfigAsText(query.data.project)

    res.json({
      config: configText,
    })
  })

  app.get('/api/projects/:project/diff-history', (req, res) => {
    const paramsValidation = projectParamsSchema.safeParse(req.params)
    if (!paramsValidation.success) {
      res.status(400).json({ errors: paramsValidation.message })
      return
    }
    const queryValidation = diffHistoryQuerySchema.safeParse(req.query)
    if (!queryValidation.success) {
      res.status(400).json({ errors: queryValidation.message })
      return
    }
    const { project } = paramsValidation.data
    const offset = queryValidation.data.offset ?? 0
    const limit = queryValidation.data.limit ?? 10

    const projectPath = configReader.getProjectPath(project)
    const filePath = path.join(projectPath, 'diffHistory.md')
    if (!existsSync(filePath)) {
      res.json({ total: 0, entries: [] })
      return
    }
    const content = readFileSync(filePath, 'utf-8')
    const entries = diffHistoryParser.parse(content)
    res.json({
      total: entries.length,
      entries: entries.slice(offset, offset + limit),
    })
  })

  app.use(express.static(STATIC_ROOT))

  attachDiffoveryRouter(app, diffoveryController)
  attachLayoutRouter(app, configReader, readonly)

  if (!readonly) {
    attachAnalyzeRouter(app, configReader)
    attachTemplateRouter(app, templateService)
    attachConfigRouter(app, configReader, configWriter, templateService)

    app.get('/api/config/health', (_, res) => {
      const response = getConfigHealth(
        configReader,
        templateService,
        configHealthService,
      )
      res.json(response)
    })

    app.get('/api/handlers', (_req, res) => {
      res.json({
        handlers: Object.entries(UserHandlers).map(([type, definition]) => ({
          type,
          schema: toJsonSchema(definition),
          // TODO: add docs
          docs: '',
          // TODO: add examples
          examples: [],
        })),
      })
    })

    app.get('/api/projects/:project/codeSearch', (req, res) => {
      const paramsValidation = projectSearchTermParamsSchema.safeParse({
        project: req.params.project,
        searchTerm: req.query.searchTerm,
        address: req.query.address,
      })

      if (!paramsValidation.success) {
        res.status(400).json({ errors: paramsValidation.message })
        return
      }
      const { project, searchTerm, address } = paramsValidation.data

      const response = searchCode(configReader, project, searchTerm, address)
      res.json(response)
    })

    app.get('/api/terminal/discover', (req, res) => {
      const queryValidation = discoverQuerySchema.safeParse(req.query)
      if (!queryValidation.success) {
        res.status(400).json({ errors: queryValidation.message })
        return
      }
      const { project, devMode } = queryValidation.data

      executeTerminalCommand(
        `l2b discover ${project} ${devMode ? '--dev' : ''}`,
        res,
      )
    })

    app.get('/api/terminal/match-flat', (req, res) => {
      const queryValidation = matchFlatQuerySchema.safeParse(req.query)
      if (!queryValidation.success) {
        res.status(400).json({ errors: queryValidation.message })
        return
      }
      const { project, address, against } = queryValidation.data

      const { codePaths } = getCodePaths(configReader, project, address)
      const implementationPath =
        codePaths.length > 1 ? codePaths[1].path : codePaths[0].path
      const againstPath =
        against === 'templates' ? './projects/_templates/' : './projects/'

      executeTerminalCommand(
        `cd ${path.dirname(
          paths.discovery,
        )} && l2b match-flat file "${implementationPath}" "${againstPath}"`,
        res,
      )
    })

    app.get('/api/terminal/download-all-shapes', (_req, res) => {
      executeTerminalCommand(
        `cd ${path.dirname(paths.discovery)}/../ && l2b download-all-shapes`,
        res,
      )
    })

    app.get('/api/terminal/find-minters', (req, res) => {
      const queryValidation = findMintersSchema.safeParse(req.query)
      if (!queryValidation.success) {
        res.status(400).json({ errors: queryValidation.message })
        return
      }
      const { address } = queryValidation.data

      executeTerminalCommand(
        `cd ${path.dirname(paths.discovery)}/../../backend && l2b minters ${address}`,
        res,
      )
    })
  }

  app.get('*', (_req, res) => {
    res.sendFile(join(STATIC_ROOT, 'index.html'))
  })

  // Bound to loopback, not 0.0.0.0.
  //
  // `app.listen(port)` with no host makes Node listen on every interface, so this
  // service was reachable from the whole local network while the log line below
  // said "localhost". When started without --readonly it mounts, with no
  // authentication, CORS check or origin check anywhere in this file:
  //   - /api/terminal/discover, /api/terminal/match-flat,
  //     /api/terminal/download-all-shapes and /api/terminal/find-minters, which all
  //     go through executeTerminalCommand -> spawn(cmd, { shell: true, env:
  //     { ...process.env } }) and stream the process's stdout and stderr back to the
  //     caller over SSE. download-all-shapes takes no parameters at all.
  //   - attachConfigRouter's write routes, which edit files in the checkout.
  //
  // The interpolated parameters themselves are constrained -- `project` goes through
  // safeStringSchema (/^[a-zA-Z0-9_-]+$/) and addresses through
  // ChainSpecificAddress -- so this is not shell injection. It does not need to be:
  // the endpoints do useful damage with entirely well-formed arguments.
  //
  // HOST is honoured so anyone who was deliberately reaching the UI from another
  // machine can restore that explicitly with HOST=0.0.0.0.
  const host = process.env.HOST ?? '127.0.0.1'

  const server = app.listen(port, host, () => {
    console.log(`Discovery UI live on http://localhost:${port}/ui`)
  })

  attachGracefulShutdown(server)
}

function shutdown(server: Server) {
  server.close(() => {
    process.exit(0)
  })

  setTimeout(() => {
    console.error(
      'Could not close connections in time, forcefully shutting down',
    )
    process.exit(1)
  }, 10000)
}

function attachGracefulShutdown(server: Server) {
  process.on('SIGTERM', () => shutdown(server))
  process.on('SIGINT', () => shutdown(server))
}