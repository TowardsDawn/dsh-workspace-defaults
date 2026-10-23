/**
 * 工作区默认预设 / 默认模型（Host 侧）。
 *
 * 职责：
 *  1. 新会话创建时注入工作区默认的预设与模型（见下方两个包装）；
 *  2. 为 Web 设置页提供数据接口（/workspace-defaults/api/*）。
 *
 * 配置存放：$DSH_HOME/workspace-defaults.json
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'workspace-defaults'

/** 没有硬依赖：各项能力按可用服务逐个注入。 */
export const inject = []

const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
const STORE_FILE = path.join(DSH_HOME, 'workspace-defaults.json')
const API = '/workspace-defaults/api'
const PATCHED = Symbol.for('dsh.workspace-defaults.patched')

/** 每个 createAgent 调用自己的模型覆盖值，并发创建会话时互不干扰。 */
const modelOverride = new AsyncLocalStorage()

let writeChain = Promise.resolve()

function normalizeKey(workspace) {
  return path.resolve(workspace).replace(/[\\/]+$/, '').toLowerCase()
}

async function readStore() {
  try {
    const parsed = JSON.parse(await readFile(STORE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.workspaces && typeof parsed.workspaces === 'object') {
      return { version: 1, workspaces: parsed.workspaces }
    }
  } catch {
    // Missing or unreadable store: behave as "no defaults configured".
  }
  return { version: 1, workspaces: {} }
}

async function writeStore(store) {
  writeChain = writeChain.then(async () => {
    await mkdir(DSH_HOME, { recursive: true })
    const tmp = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await rename(tmp, STORE_FILE)
  })
  return writeChain
}

function findEntry(store, workspace) {
  const key = normalizeKey(workspace)
  for (const [stored, entry] of Object.entries(store.workspaces)) {
    if (normalizeKey(stored) === key) return { key: stored, entry }
  }
  return undefined
}

/**
 * 合并式更新一个工作区的配置。
 * @param {string} workspace - 工作区目录。
 * @param {{ preset?: string | null, model?: { provider: string, model: string } | null }} patch
 * @returns {Promise<{ workspace: string, entry: object }>}
 */
async function setDefaults(workspace, patch) {
  const store = await readStore()
  const found = findEntry(store, workspace)
  const key = found?.key ?? path.resolve(workspace)
  const entry = { ...(found?.entry ?? {}) }
  if (patch.preset !== undefined) {
    if (patch.preset === null || patch.preset === '') delete entry.agentPreset
    else entry.agentPreset = patch.preset
  }
  if (patch.model !== undefined) {
    if (patch.model === null) delete entry.model
    else entry.model = { provider: patch.model.provider, model: patch.model.model }
  }
  if (entry.agentPreset === undefined && entry.model === undefined) delete store.workspaces[key]
  else store.workspaces[key] = entry
  await writeStore(store)
  return { workspace: key, entry }
}

async function readJsonBody(req, limit = 1_000_000) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > limit) throw new Error('request body too large')
  }
  if (raw.trim() === '') return {}
  return JSON.parse(raw)
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

/** 设置页需要的全部数据。 */
async function collectState(ctx) {
  const store = await readStore()
  const defaults = Object.entries(store.workspaces).map(([workspace, entry]) => ({
    workspace,
    preset: entry.agentPreset ?? null,
    provider: entry.model?.provider ?? null,
    model: entry.model?.model ?? null,
  }))

  const workspaces = []
  try {
    for (const workspace of ctx.get('workspaceRegistry')?.list?.() ?? []) {
      workspaces.push({ path: workspace.path, title: workspace.title ?? workspace.path })
    }
  } catch {
    // Workspace listing is advisory; the form also accepts a typed path.
  }

  const presets = []
  try {
    for (const preset of (await ctx.get('agentPresets')?.list?.()) ?? []) {
      presets.push({ id: preset.id, name: preset.name ?? preset.id, description: preset.description ?? '' })
    }
  } catch {
    // Presets are advisory.
  }

  const providers = []
  const llm = ctx.get('llm')
  if (llm !== undefined) {
    for (const provider of llm.listProviders()) {
      const models = []
      try {
        for (const model of await llm.listModels(provider.id)) {
          models.push({ id: model.id, name: model.name ?? model.id })
        }
      } catch {
        // A provider without credentials or a reachable endpoint simply offers no models.
      }
      providers.push({ id: provider.id, name: provider.name ?? provider.id, models })
    }
  }

  let defaultModel = null
  try {
    defaultModel = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
  } catch {
    // Advisory only.
  }

  return { workspaces, presets, providers, defaults, defaultModel }
}

export function apply(ctx) {
  // ── 新会话的默认预设 ────────────────────────────────────────────────
  ctx.inject(['sessionController', 'agentPresets'], (c) => {
    const controller = c.sessionController
    const original = controller?.createSession
    if (typeof original !== 'function' || original[PATCHED] === true) return
    const wrapped = async function (request, ...rest) {
      if (request !== undefined && request !== null
        && request.agentPreset === undefined
        && typeof request.cwd === 'string') {
        const store = await readStore()
        const configured = findEntry(store, request.cwd)?.entry?.agentPreset
        if (configured !== undefined) {
          try {
            await c.agentPresets.resolve(configured)
            request = { ...request, agentPreset: configured }
          } catch {
            // A stale preset id must not break session creation: fall back to the deployment default.
          }
        }
      }
      return original.call(this, request, ...rest)
    }
    wrapped[PATCHED] = true
    controller.createSession = wrapped
    c.on('dispose', () => {
      if (controller.createSession === wrapped) controller.createSession = original
    })
  })

  // ── 新会话的默认模型 ────────────────────────────────────────────────
  ctx.inject(['sessionController', 'agentDefaultModel'], (c) => {
    const controller = c.sessionController
    const model = c.agentDefaultModel

    const originalSelection = model?.currentSelection
    if (typeof originalSelection === 'function' && originalSelection[PATCHED] !== true) {
      const bound = originalSelection.bind(model)
      const wrapped = function (...args) {
        const override = modelOverride.getStore()
        return override ?? bound(...args)
      }
      wrapped[PATCHED] = true
      model.currentSelection = wrapped
      c.on('dispose', () => {
        if (model.currentSelection === wrapped) model.currentSelection = originalSelection
      })
    }

    const originalCreateAgent = controller?.createAgent
    if (typeof originalCreateAgent !== 'function' || originalCreateAgent[PATCHED] === true) return
    const wrapped = async function (sessionId, cwd, composition, ...rest) {
      if (typeof cwd === 'string') {
        const store = await readStore()
        const configured = findEntry(store, cwd)?.entry?.model
        if (configured !== undefined) {
          return modelOverride.run(
            { provider: configured.provider, model: configured.model },
            () => originalCreateAgent.call(this, sessionId, cwd, composition, ...rest),
          )
        }
      }
      return originalCreateAgent.call(this, sessionId, cwd, composition, ...rest)
    }
    wrapped[PATCHED] = true
    controller.createAgent = wrapped
    c.on('dispose', () => {
      if (controller.createAgent === wrapped) controller.createAgent = originalCreateAgent
    })
  })

  // ── 设置页数据接口 ────────────────────────────────────────────────
  ctx.inject(['webServer'], (c) => {
    c.effect(() => c.webServer.register({
      kind: 'exact',
      path: `${API}/state`,
      async handler(req, res) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'only GET is supported' })
          return
        }
        try {
          sendJson(res, 200, await collectState(c))
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))

    c.effect(() => c.webServer.register({
      kind: 'exact',
      path: `${API}/set`,
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'only POST is supported' })
          return
        }
        try {
          const body = await readJsonBody(req)
          if (typeof body.workspace !== 'string' || body.workspace.trim() === '') {
            throw new Error('workspace is required')
          }
          const patch = {}
          if (body.preset !== undefined && body.preset !== null && body.preset !== '') patch.preset = body.preset
          if (typeof body.provider === 'string' && body.provider !== ''
            && typeof body.model === 'string' && body.model !== '') {
            patch.model = { provider: body.provider, model: body.model }
          }
          if (patch.preset === undefined && patch.model === undefined) {
            throw new Error('set needs preset and/or provider+model')
          }
          if (patch.preset !== undefined) {
            const presets = c.get('agentPresets')
            if (presets !== undefined) await presets.resolve(patch.preset)
          }
          sendJson(res, 200, { ok: true, ...(await setDefaults(body.workspace, patch)) })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))

    c.effect(() => c.webServer.register({
      kind: 'exact',
      path: `${API}/unset`,
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'only POST is supported' })
          return
        }
        try {
          const body = await readJsonBody(req)
          if (typeof body.workspace !== 'string' || body.workspace.trim() === '') {
            throw new Error('workspace is required')
          }
          const clear = body.clear === 'preset' || body.clear === 'model' ? body.clear : 'all'
          const patch = {}
          if (clear === 'preset' || clear === 'all') patch.preset = null
          if (clear === 'model' || clear === 'all') patch.model = null
          sendJson(res, 200, { ok: true, ...(await setDefaults(body.workspace, patch)) })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))
  })

}
