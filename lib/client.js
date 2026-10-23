/**
 * 工作区默认预设 / 默认模型（浏览器侧）。
 *
 * 在 Settings 面板注册一个一级设置页「工作区默认」，通过
 * /workspace-defaults/api/* 与 Host 侧交换数据。
 */
window.__ModuleLoader__.load({
  id: '@TowardsDawn/dsh-workspace-defaults',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/workspace-defaults/api'

    async function api(path, init) {
      const response = await fetch(API + path, {
        credentials: 'same-origin',
        headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
        ...init,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    function label(text) {
      return h('span', { style: { display: 'block', marginBottom: 4, fontSize: 12, opacity: 0.75 } }, text)
    }

    function select(props) {
      return h('select', {
        ...props,
        style: {
          width: '100%',
          padding: '6px 8px',
          borderRadius: 6,
          border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
          background: 'transparent',
          color: 'inherit',
          ...props.style,
        },
      })
    }

    function button(labelText, onClick, kind) {
      return h('button', {
        type: 'button',
        onClick,
        style: {
          padding: '6px 14px',
          borderRadius: 6,
          border: '1px solid color-mix(in srgb, currentColor 26%, transparent)',
          background: kind === 'primary' ? 'color-mix(in srgb, currentColor 12%, transparent)' : 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 13,
        },
      }, labelText)
    }

    function WorkspaceDefaultsSection() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [workspace, setWorkspace] = React.useState('')
      const [preset, setPreset] = React.useState('')
      const [provider, setProvider] = React.useState('')
      const [model, setModel] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const next = await api('/state')
          setData(next)
          setError('')
          if (next.defaults.length > 0 && workspace === '') {
            const first = next.defaults[0]
            setWorkspace(first.workspace)
            setPreset(first.preset ?? '')
            setProvider(first.provider ?? '')
            setModel(first.model ?? '')
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }, [workspace])

      React.useEffect(() => { load() }, [])

      const current = data === null ? undefined : data.defaults.find((item) => item.workspace === workspace)
      const providers = data === null ? [] : data.providers
      const models = providers.find((item) => item.id === provider)?.models ?? []

      function pickWorkspace(value) {
        setWorkspace(value)
        const found = data?.defaults.find((item) => item.workspace === value)
        setPreset(found?.preset ?? '')
        setProvider(found?.provider ?? '')
        setModel(found?.model ?? '')
      }

      async function save() {
        if (workspace.trim() === '') { setError('请填写工作区目录'); return }
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const body = { workspace: workspace.trim() }
          if (preset !== '') body.preset = preset
          if (provider !== '' && model !== '') { body.provider = provider; body.model = model }
          if (body.preset === undefined && body.provider === undefined) throw new Error('请至少选择默认预设或默认模型')
          await api('/set', { method: 'POST', body: JSON.stringify(body) })
          setNotice('已保存')
          await load()
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally { setBusy(false) }
      }

      async function clear(clearWhat) {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          await api('/unset', { method: 'POST', body: JSON.stringify({ workspace, clear: clearWhat }) })
          setNotice('已清除')
          setPreset(''); setProvider(''); setModel('')
          await load()
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally { setBusy(false) }
      }

      const datalistId = 'workspace-defaults-workspaces'

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px', fontSize: 13 } }, [
        h('div', { key: 'intro' }, [
          h('div', { key: 't', style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, '工作区默认'),
          h('div', { key: 'd', style: { opacity: 0.7, lineHeight: 1.6 } },
            '为该工作区下新建的会话指定默认预设与默认模型。已有会话不受影响，会话内仍可随时切换。'),
        ]),
        error !== '' ? h('div', { key: 'err', style: { color: 'crimson' } }, error) : null,
        notice !== '' ? h('div', { key: 'ok', style: { opacity: 0.75 } }, notice) : null,

        h('div', { key: 'form', style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 } }, [
          h('div', { key: 'ws' }, [
            label('工作区目录'),
            h('input', {
              list: datalistId,
              value: workspace,
              placeholder: '例如 E:\\projects\\app',
              onChange: (event) => pickWorkspace(event.target.value),
              style: {
                width: '100%', padding: '6px 8px', borderRadius: 6, boxSizing: 'border-box',
                border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
                background: 'transparent', color: 'inherit',
              },
            }),
            h('datalist', { id: datalistId },
              (data?.workspaces ?? []).map((item) => h('option', { key: item.path, value: item.path }, item.title))),
          ]),
          h('div', { key: 'preset' }, [
            label('默认预设'),
            select({
              value: preset,
              onChange: (event) => setPreset(event.target.value),
              children: [
                h('option', { key: '', value: '' }, '（不设置）'),
                ...(data?.presets ?? []).map((item) => h('option', { key: item.id, value: item.id }, `${item.name}（${item.id}）`)),
              ],
            }),
          ]),
          h('div', { key: 'model', style: { display: 'flex', gap: 12 } }, [
            h('div', { key: 'p', style: { flex: 1 } }, [
              label('默认模型 · Provider'),
              select({
                value: provider,
                onChange: (event) => { setProvider(event.target.value); setModel('') },
                children: [
                  h('option', { key: '', value: '' }, '（不设置）'),
                  ...providers.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
                ],
              }),
            ]),
            h('div', { key: 'm', style: { flex: 1 } }, [
              label('默认模型 · Model'),
              select({
                value: model,
                onChange: (event) => setModel(event.target.value),
                disabled: provider === '',
                children: [
                  h('option', { key: '', value: '' }, '（不设置）'),
                  ...models.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
                ],
              }),
            ]),
          ]),
          h('div', { key: 'actions', style: { display: 'flex', gap: 8, marginTop: 4 } }, [
            button(busy ? '保存中…' : '保存', save, 'primary'),
            button('清除此工作区', () => clear('all')),
          ]),
          current !== undefined
            ? h('div', { key: 'cur', style: { opacity: 0.65 } },
                `当前：预设 ${current.preset ?? '未设置'}；模型 ${current.provider === null ? '未设置' : `${current.provider} / ${current.model}`}`)
            : null,
        ]),

        h('div', { key: 'table' }, [
          h('div', { key: 'th', style: { fontWeight: 600, marginBottom: 6 } }, '已配置的工作区'),
          data === null || data.defaults.length === 0
            ? h('div', { key: 'empty', style: { opacity: 0.6 } }, '暂无配置')
            : h('table', { key: 'tb', style: { width: '100%', borderCollapse: 'collapse' } }, [
                h('thead', { key: 'thead' }, h('tr', { key: 'r' }, [
                  h('th', { key: 'w', style: { textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid color-mix(in srgb, currentColor 18%, transparent)' } }, '工作区'),
                  h('th', { key: 'p', style: { textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid color-mix(in srgb, currentColor 18%, transparent)' } }, '预设'),
                  h('th', { key: 'm', style: { textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid color-mix(in srgb, currentColor 18%, transparent)' } }, '模型'),
                  h('th', { key: 'a', style: { padding: '4px 6px', borderBottom: '1px solid color-mix(in srgb, currentColor 18%, transparent)' } }, ''),
                ])),
                h('tbody', { key: 'tbody' }, data.defaults.map((item) => h('tr', { key: item.workspace }, [
                  h('td', { key: 'w', style: { padding: '4px 6px', wordBreak: 'break-all' } }, item.workspace),
                  h('td', { key: 'p', style: { padding: '4px 6px' } }, item.preset ?? '—'),
                  h('td', { key: 'm', style: { padding: '4px 6px' } },
                    item.provider === null ? '—' : `${item.provider} / ${item.model}`),
                  h('td', { key: 'a', style: { padding: '4px 6px', textAlign: 'right' } },
                    button('删除', async () => {
                      setBusy(true)
                      try {
                        await api('/unset', { method: 'POST', body: JSON.stringify({ workspace: item.workspace, clear: 'all' }) })
                        await load()
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e))
                      } finally { setBusy(false) }
                    })),
                ]))),
              ]),
        ]),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'workspace-defaults',
          order: 120,
          label: () => '工作区默认',
          children: {},
        }, WorkspaceDefaultsSection)))
      },
    }
  },
})
