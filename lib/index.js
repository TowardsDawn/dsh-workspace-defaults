/**
 * 工作区默认预设 / 默认模型。
 *
 * 只影响「新会话创建」这一条路径：
 *   - 预设：sessionController.createSession 之前，request.agentPreset 未指定时
 *     按工作区配置补全；会话内的预设切换（agentPresets.select）不经过这里。
 *   - 模型：sessionController.createAgent 期间用 AsyncLocalStorage 临时覆盖
 *     agentDefaultModel.currentSelection()，只影响本次新建会话；已有会话的
 *     model/selection 事件与后续请求不受影响。
 *
 * 配置存放：$DSH_HOME/workspace-defaults.json
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'workspace-defaults'

/** 命令注册是本插件唯一的硬依赖；其余服务按需注入，缺失时对应能力自动关闭。 */
export const inject = ['commands']

const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
const STORE_FILE = path.join(DSH_HOME, 'workspace-defaults.json')
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

function renderEntry(workspace, entry) {
  const preset = entry?.agentPreset ?? '（未设置）'
  const model = entry?.model ? `${entry.model.provider} / ${entry.model.model}` : '（未设置）'
  return `${workspace}\n  默认预设: ${preset}\n  默认模型: ${model}`
}

async function listAll() {
  const store = await readStore()
  const entries = Object.entries(store.workspaces)
  if (entries.length === 0) return '尚未为任何工作区设置默认预设或默认模型。'
  return entries.map(([workspace, entry]) => renderEntry(workspace, entry)).join('\n\n')
}

/**
 * 合并式更新一个工作区的配置。
 * @param {string} workspace - 工作区目录。
 * @param {{ preset?: string | null, model?: { provider: string, model: string } | null }} patch
 * @returns {Promise<string>} 更新后的可读描述。
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
  return renderEntry(key, entry)
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

  // ── 斜杠命令：/workspace-default ────────────────────────────────────
  ctx.inject(['commands', 'workingDirectory', 'agentPresets'], (c) => {
    c.commands.register({
      name: 'workspace-default',
      description: '设置本工作区新会话的默认预设 / 默认模型',
      input: { hint: 'list | preset <id|off> | model <provider> <model|off>' },
      handler: async ({ agent, rawInput }) => {
        try {
          const workspace = c.workingDirectory.get(agent.session)
          const parts = rawInput.trim().split(/\s+/).filter(Boolean)
          const sub = parts[0] ?? 'list'
          if (sub === 'list' || sub === 'all') return { kind: 'success', text: await listAll() }
          if (sub === 'preset') {
            const id = parts[1]
            if (id === undefined) return { kind: 'error', text: '用法: /workspace-default preset <预设 id|off>' }
            if (id !== 'off') {
              try {
                await c.agentPresets.resolve(id)
              } catch {
                return { kind: 'error', text: `未知预设: ${id}` }
              }
            }
            return { kind: 'success', text: await setDefaults(workspace, { preset: id === 'off' ? null : id }) }
          }
          if (sub === 'model') {
            const provider = parts[1]
            const modelId = parts.slice(2).join(' ')
            if (provider === undefined) return { kind: 'error', text: '用法: /workspace-default model <provider> <model|off>' }
            if (provider === 'off') return { kind: 'success', text: await setDefaults(workspace, { model: null }) }
            if (modelId === '') return { kind: 'error', text: '用法: /workspace-default model <provider> <model|off>' }
            return { kind: 'success', text: await setDefaults(workspace, { model: { provider, model: modelId } }) }
          }
          return { kind: 'error', text: '用法: /workspace-default [list | preset <id|off> | model <provider> <model|off>]' }
        } catch (error) {
          return { kind: 'error', text: `操作失败: ${error instanceof Error ? error.message : String(error)}` }
        }
      },
    })
  })

  // ── 工具：workspace_default ────────────────────────────────────────
  ctx.inject(['tools', 'workingDirectory', 'agentPresets'], (c) => {
    c.tools.register({
      name: 'workspace_default',
      description: 'Read or set the default agent preset and default model for a workspace. They apply to newly created sessions in that workspace; existing sessions keep their own choices.',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'set', 'unset'], description: 'list all, set fields, or unset fields.' },
        workspace: { type: 'string', description: 'Workspace directory; defaults to the calling session working directory.' },
        preset: { type: 'string', description: 'Agent preset id for set.' },
        provider: { type: 'string', description: 'Provider id for set.' },
        model: { type: 'string', description: 'Model id for set.' },
        clear: { type: 'string', enum: ['preset', 'model', 'all'], description: 'What unset removes; defaults to all.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        try {
          if (args.action === 'list') return await listAll()
          const workspace = args.workspace
            ?? (exec.agent === undefined ? undefined : c.workingDirectory.get(exec.agent.session))
          if (workspace === undefined) throw new Error('workspace is required outside a session')
          if (args.action === 'set') {
            const patch = {}
            if (args.preset !== undefined) patch.preset = args.preset
            if (args.provider !== undefined && args.model !== undefined) {
              patch.model = { provider: args.provider, model: args.model }
            }
            if (patch.preset === undefined && patch.model === undefined) {
              throw new Error('set needs preset and/or provider+model')
            }
            if (patch.preset !== undefined) {
              try {
                await c.agentPresets.resolve(patch.preset)
              } catch {
                throw new Error(`unknown preset: ${patch.preset}`)
              }
            }
            return await setDefaults(workspace, patch)
          }
          if (args.action === 'unset') {
            const clear = args.clear ?? 'all'
            const patch = {}
            if (clear === 'preset' || clear === 'all') patch.preset = null
            if (clear === 'model' || clear === 'all') patch.model = null
            return await setDefaults(workspace, patch)
          }
          throw new Error(`unknown action: ${args.action}`)
        } catch (error) {
          return `error: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    })
  })
}
