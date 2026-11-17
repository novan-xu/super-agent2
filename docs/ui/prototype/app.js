(() => {
  'use strict'
  const D = window.SA_DATA

  const $ = (s, r = document) => r.querySelector(s)
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s))
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const pad = n => String(n).padStart(2, '0')
  const clock = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
  const rand8 = () => Math.random().toString(16).slice(2, 10).padEnd(8, '0')
  const EN = D.engines
  const size = b => b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`
  const shorten = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t)

  const I = {
    chat: '<path d="M4 5.5h16v10.5H10l-5 4v-4H4z"/>',
    inbox: '<path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5"/><path d="M5.5 5h13L21 13.5V19H3v-5.5z"/>',
    ticket: '<path d="M8.5 4.5h7V7h-7z"/><path d="M15.5 5.5h3V20h-13V5.5h3"/><path d="M9 11h6M9 15h4"/>',
    memory: '<path d="M6.5 3.5h11v17L12 16.5l-5.5 4z"/>',
    machine: '<rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M8.5 20h7M12 16.5V20"/>',
    repo: '<path d="M5.5 18.5V5.5a2 2 0 0 1 2-2h11v14h-11a2 2 0 0 0-2 2 2 2 0 0 0 2 2h11"/><path d="M9 7.5h6"/>',
    rules: '<path d="M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4"/>',
    connect: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
    send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    chev: '<path d="M9.5 6l6 6-6 6"/>',
    ext: '<path d="M8 16L16 8M9.5 8H16v6.5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    compose: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
    doc: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 12h6M9 16h4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>',
    bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 21h4"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9"/>',
    clip: '<path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.2-8.2a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.2a1.6 1.6 0 0 1-2.3-2.3l7.6-7.6"/>',
    hub: '<circle cx="12" cy="12" r="2.5"/><circle cx="5" cy="5" r="1.5"/><circle cx="19" cy="5" r="1.5"/><circle cx="5" cy="19" r="1.5"/><circle cx="19" cy="19" r="1.5"/><path d="M6.2 6.2l3.9 3.9M17.8 6.2l-3.9 3.9M6.2 17.8l3.9-3.9M17.8 17.8l-3.9-3.9"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
    tray: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M3 12.5h5l1.5 2h5l1.5-2h5"/><path d="M8 20.5h8"/>',
    branch: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="7.5" r="2"/><path d="M6.5 7.5v9M17.5 9.5c0 4.5-5 4-10 7"/>',
    pr: '<circle cx="6.5" cy="6" r="2"/><circle cx="6.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/><path d="M6.5 8v8M17.5 16V10a3 3 0 0 0-3-3h-3"/><path d="M13.5 4.5L11 7l2.5 2.5"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-3a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3"/>',
    swap: '<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>',
    alert: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4M12 17h.01"/>',
    question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2-2.4 3.5M12 17h.01"/>',
  }
  const ic = (n, px) => `<svg class="od-icon"${px ? ` style="--od-icon-size:${px}px"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`
  const logo = (s = 22) => `<svg class="logo" width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="var(--accent)"/><g transform="translate(2.16 2.16) scale(.82)"><circle cx="12" cy="12" r="3.3" fill="var(--accent-on)"/><path d="M19.24 10.06A7.5 7.5 0 1 1 13.94 4.76" fill="none" stroke="var(--accent-on)" stroke-width="2" stroke-linecap="round"/><circle cx="17.4" cy="6.6" r="2.1" fill="var(--accent-on)"/></g></svg>`
  const typing = '<span class="typing" aria-label="正在输入"><i></i><i></i><i></i></span>'
  const para = t => esc(t).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\b(tkt_[0-9a-f]{8})\b/g, '<code>$1</code>')}</p>`).join('')

  const STATES = {
    question: ['等你回答', 'warn'], blocked: ['受阻', 'bad'], working: ['进行中', 'ok', true], queued: ['排队', 'mute'],
    ready: ['已交付', 'info'], merged: ['已合并', 'ok'], completed: ['已完成', 'ok'], stopped: ['已停止', 'mute'], failed: ['失败', 'bad'],
  }
  const OPEN = new Set(['question', 'blocked', 'working', 'queued', 'ready'])
  const status = (tone, label, live) => `<span class="status status--${tone}"><span class="dot dot--${tone}${live ? ' dot--live' : ''}"></span><span>${esc(label)}</span></span>`
  const stateStatus = s => { const [l, t, live] = STATES[s] || [s, 'mute']; return status(t, l, live) }
  const CI = { passing: ['ok', '通过'], failing: ['bad', '失败'], running: ['info', '运行中'], none: ['mute', '还没有'] }
  const where = t => `${t.machine} · ${EN[t.engine]}`

  const S = {
    route: { view: 'conv' }, prev: null, dest: 'code', theme: 'dark',
    drafts: {}, att: { code: [], chat: [] }, q: {}, busy: new Set(), errors: {},
    ticketsTab: 'open', memTab: 'mem', memEditor: null, showArchived: false,
    planView: {}, planRevise: new Set(), panelOpen: false,
    machineOs: 'Windows', machineCmd: null, pairing: null,
    recording: null, keyNote: {}, filesSort: 'date', modelDrafts: {},
    trayOpen: true, focusSel: null, seq: 100, accent: '#f2b705',
  }
  try { const t = localStorage.getItem('sa-theme'); if (t) S.theme = t; const a = localStorage.getItem('sa-accent'); if (/^#[0-9a-f]{6}$/i.test(a || '')) S.accent = a } catch {  }
  const id = p => `${p}${++S.seq}`

  const ticket = tid => D.tickets.find(t => t.id === tid)
  const startOf = sid => D.starts.find(s => s.id === sid)
  const planOf = pid => D.plans.find(p => p.id === pid)

  function inbox() {
    const answer = D.tickets.filter(t => t.state === 'question' || t.state === 'blocked')
    const confirm = [
      ...D.starts.filter(s => !s.status).map(x => ({ k: 'start', x })),
      ...D.plans.filter(p => p.status === 'pending').map(x => ({ k: 'plan', x })),
      ...D.pulls.filter(p => !p.done).map(x => ({ k: 'pull', x })),
    ]
    const optional = D.candidates.filter(c => !c.done)
    return { answer, confirm, optional, total: answer.length + confirm.length + optional.length }
  }
  function waitingLines() {
    const g = inbox()
    return [
      ...g.answer.map(t => ({ tone: t.state === 'blocked' ? 'bad' : 'warn', kind: t.state === 'blocked' ? '受阻' : '问题', title: t.title, act: 'open-ticket', id: t.id })),
      ...g.confirm.map(({ k, x }) => ({ tone: 'info', kind: k === 'start' ? '开工' : k === 'plan' ? '计划' : 'PR', title: k === 'pull' ? `${x.repo.split('/')[1]} #${x.n}` : x.title, act: k === 'plan' ? 'open-plan' : 'nav', id: x.id, view: 'inbox' })),
      ...g.optional.map(c => ({ tone: 'mute', kind: '派单', title: c.title, act: 'nav', view: 'inbox' })),
    ]
  }
  const openTickets = () => D.tickets.filter(t => OPEN.has(t.state))
  const pendingMemory = () => D.memory.filter(m => m.state === 'pending').length

  const NAV = [
    { view: 'conv', icon: 'chat', label: '对话' },
    { view: 'inbox', icon: 'inbox', label: '待办', count: () => inbox().total, hot: true },
    { view: 'tickets', icon: 'ticket', label: '工单', count: () => openTickets().length },
    { view: 'memory', icon: 'memory', label: '记忆', count: pendingMemory, hot: true },
  ]
  const NAV_FOOT = [{ view: 'tray', icon: 'tray', label: '托盘弹窗' }, { view: 'settings', icon: 'gear', label: '设置' }]
  const TABS = [...NAV, { view: 'settings', icon: 'gear', label: '设置' }]
  const SECTIONS = [
    { group: '执行', items: [['machines', '机器', 'machine'], ['models', '模型', 'hub'], ['repos', '仓库', 'repo']] },
    { group: '规则与通知', items: [['rules', '规则', 'rules'], ['notifications', '通知', 'bell']] },
    { group: '连接与设备', items: [['connections', '连接', 'connect']] },
    { group: '个人', items: [['appearance', '外观', 'sun'], ['shortcuts', '快捷键', 'keyboard'], ['files', '文件', 'doc']] },
  ]
  const SECTION_NAME = Object.fromEntries(SECTIONS.flatMap(g => g.items.map(([k, n]) => [k, n])))
  const navOf = v => (v === 'ticket' ? 'tickets' : v === 'plan' ? 'conv' : v)

  function go(view, param, opts = {}) {
    S.prev = S.route
    S.route = { view, param }
    S.panelOpen = false
    try { const h = `#/${view}${param ? '/' + param : ''}`; if (location.hash !== h) history.replaceState(null, '', h) } catch {  }
    render({ top: true, ...opts })
    $('#main').focus({ preventScroll: true })
  }
  function parseHash() {
    const m = (location.hash || '').match(/^#\/(\w+)(?:\/([\w-]+))?/)
    const views = ['conv', 'inbox', 'tickets', 'ticket', 'plan', 'memory', 'settings', 'tray']
    if (m && views.includes(m[1])) return { view: m[1], param: m[2] }
    return { view: 'conv' }
  }

  const media = window.matchMedia('(prefers-color-scheme: light)')
  const applyTheme = () => { document.documentElement.dataset.theme = S.theme === 'system' ? (media.matches ? 'light' : 'dark') : S.theme; applyAccent() }

  const ACCENTS = [['#f2b705', '琥珀'], ['#3fb68b', '青绿'], ['#5b8def', '蓝'], ['#a07cf0', '紫'], ['#e46f8f', '玫红'], ['#d6d0c4', '石墨']]
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  const hex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
  const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
  const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
  function applyAccent() {
    const dark = document.documentElement.dataset.theme !== 'light'
    const base = rgb(S.accent)
    const toward = dark ? [255, 255, 255] : [0, 0, 0]
    const ground = dark ? [22, 21, 20] : [255, 255, 255]
    const surface = dark ? [30, 29, 27] : [255, 255, 255]
    let fill = base
    for (let t = 0.05; contrast(fill, ground) < (dark ? 3 : 1.6) && t <= 1; t += 0.05) fill = mixc(base, toward, t)
    let text = fill
    for (let t = 0.05; contrast(text, surface) < 4.5 && t <= 1; t += 0.05) text = mixc(fill, toward, t)
    const on = contrast(fill, [26, 25, 23]) >= contrast(fill, [255, 255, 255]) ? '#1a1917' : '#ffffff'
    const [r, g, b] = fill.map(Math.round)
    const st = document.documentElement.style
    st.setProperty('--accent', hex(fill))
    st.setProperty('--accent-on', on)
    st.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, ${dark ? 0.14 : 0.16})`)
    st.setProperty('--meta', hex(text))
    st.setProperty('--focus-ring', `0 0 0 3px rgba(${r}, ${g}, ${b}, 0.45)`)
  }
  media.addEventListener?.('change', () => { if (S.theme === 'system') applyTheme() })

  const machineOptions = (value, withAuto) => [
    withAuto ? `<option value="自动"${value === '自动' ? ' selected' : ''}>自动</option>` : '',
    ...D.machines.map(m => `<option value="${m.id}"${m.id === value ? ' selected' : ''}${m.connected ? '' : ' disabled'}>${esc(m.id)}${m.connected ? '' : '（离线）'}</option>`),
  ].join('')
  const engineOptions = value => Object.entries(EN).map(([k, n]) => `<option value="${k}"${k === value ? ' selected' : ''}>${n}</option>`).join('')
  const opts = (list, value) => list.map(x => `<option value="${esc(x)}"${x === value ? ' selected' : ''}>${esc(x)}</option>`).join('')
  function whereSelects(x, f, p, auto) {
    const m = D.models.find(y => y.id === x.engine)
    const sel = (key, label, inner, single) => `<div class="form-row"><label for="${p}${key}-${x.id}">${label}</label><select class="field field--sm" id="${p}${key}-${x.id}" data-change="${f}" data-id="${x.id}" data-f="${key}"${single ? ' disabled' : ''}>${inner}</select></div>`
    return `<div class="wcard-where">
      ${sel('machine', '机器', machineOptions(x.machine, auto))}
      ${sel('engine', '引擎', engineOptions(x.engine))}
      ${sel('model', '模型', opts(m.models, x.model), m.models.length < 2)}
      ${sel('effort', '推理强度', opts(m.efforts, x.effort), m.efforts.length < 2)}
    </div>`
  }
  const errLine = key => S.errors[key] ? `<p class="field-err" role="alert">${esc(S.errors[key])}</p>` : ''
  const busyCls = key => (S.busy.has(key) ? ' is-busy' : '')
  const busyAttr = key => (S.busy.has(key) ? ' disabled aria-busy="true"' : '')

  function startCard(s) {
    if (!s) return ''
    const key = `start:${s.id}`
    if (s.status) {
      const t = ticket(s.ticket)
      return `<article class="wcard wcard--done" data-start="${s.id}">
        <div class="wcard-kind">${status(s.status === 'started' ? 'ok' : 'mute', s.status === 'started' ? '已开工' : '不做了')}<span class="od-fill mono">${esc(s.repo)}</span></div>
        <h3>${esc(s.title)}</h3>
        ${t ? `<div class="done-line">${ic('check')}<span>在 ${esc(where(t))} 上运行</span><button class="inline-link mono" type="button" data-act="open-ticket" data-id="${t.id}">${t.ref}</button></div>` : ''}
      </article>`
    }
    const ticked = s.items.filter(i => !i.off).length
    const canStart = !s.items.length || ticked > 0
    return `<article class="wcard" data-start="${s.id}" aria-labelledby="h-${s.id}">
      <div class="wcard-kind"><span class="chip">${s.kind === 'digest' ? 'issue 摘要' : '开工请求'}</span><span class="chip chip--mono">${ic('repo')}${esc(s.repo)}</span><span class="od-fill num">${esc(s.time)}</span></div>
      <h3 id="h-${s.id}">${esc(s.title)}</h3>
      <p class="lede">${esc(s.summary)}</p>
      ${s.items.length ? `<div class="checks" role="group" aria-label="要做的 issue">${s.items.map((it, i) => `
        <label class="check"><input type="checkbox" data-act="start-tick" data-id="${s.id}" data-n="${i}"${it.off ? '' : ' checked'}>
          <span class="check-text"><span class="check-title">${esc(it.title)}</span><span class="check-meta mono">#${it.n}${it.label ? ' · ' + esc(it.label) : ''}</span></span></label>`).join('')}</div>` : ''}
      ${whereSelects(s, 'start-field', 's', true)}
      ${errLine(key)}
      <div class="card-actions">
        <button class="btn btn-primary${busyCls(key)}" type="button" data-act="start-go" data-id="${s.id}"${canStart ? '' : ' disabled'}${busyAttr(key)}>${ic('check')}${s.items.length ? `开始 ${ticked} 项` : '开始'}</button>
        <button class="btn btn-ghost" type="button" data-act="start-drop" data-id="${s.id}"${busyAttr(key)}>不做</button>
      </div>
    </article>`
  }

  function planState(p) {
    if (p.status === 'confirmed') return status('ok', '已开工')
    if (p.status === 'dropped') return status('mute', '不做了')
    return p.revising ? status('warn', '大脑在改') : status('info', '待确认')
  }
  function planCard(p) {
    if (!p) return ''
    const key = `plan:${p.id}`
    const t = p.ticket && ticket(p.ticket)
    return `<article class="wcard${p.status !== 'pending' ? ' wcard--done' : ''}" aria-labelledby="h-${p.id}">
      <div class="wcard-kind"><span class="chip">计划 v${p.version}</span>${planState(p)}<span class="od-fill"><span class="mono">${esc(p.repo)}</span>${p.isNew ? ' · 新仓库' : ''}</span></div>
      <h3 id="h-${p.id}">${esc(p.title)}</h3>
      <p class="lede od-clamp-3">${esc(p.goal)}</p>
      ${t ? `<div class="done-line">${ic('check')}<span>在 ${esc(where(t))} 上运行</span><button class="inline-link mono" type="button" data-act="open-ticket" data-id="${t.id}">${t.ref}</button></div>` : ''}
      <div class="card-actions">
        ${p.status === 'pending' ? `<button class="btn btn-primary${busyCls(key)}" type="button" data-act="plan-go" data-id="${p.id}"${p.revising ? ' disabled' : ''}${busyAttr(key)}>${ic('check')}开工</button>` : ''}
        <button class="btn${p.status === 'pending' ? '' : ' btn-ghost'}" type="button" data-act="open-plan" data-id="${p.id}">查看计划</button>
      </div>
    </article>`
  }

  function questionCard(t) {
    const q = t.questions
    const d = S.q[t.id] || (S.q[t.id] = { at: 0, answers: [] })
    const item = q.items[d.at]
    const total = q.items.length
    const last = d.at === total - 1
    const key = `q:${t.id}`
    const dk = `qa-${t.id}-${d.at}`
    return `<div class="qc" data-qc="${t.id}">
      <div class="qc-head">
        ${d.at > 0 ? `<button class="icon-btn" type="button" data-act="q-back" data-id="${t.id}" aria-label="上一题">${ic('back')}</button>` : ''}
        <span class="qc-pos num">${d.at + 1} / ${total}</span>
        <span class="qc-bar" aria-hidden="true"><i style="transform:scaleX(${(d.at + 1) / total})"></i></span>
      </div>
      <p class="qc-q" id="qq-${t.id}">${esc(item.text)}</p>
      <div class="qc-opts" role="group" aria-labelledby="qq-${t.id}">${(item.suggestions || []).map((s, i) => `
        <button class="qc-opt" type="button" data-act="q-pick" data-id="${t.id}" data-n="${i}" aria-pressed="${d.answers[d.at] === s.label}"${busyAttr(key)}>
          ${i === 0 ? '<span class="qc-rec">建议</span>' : ''}<span class="qc-label">${esc(s.label)}</span>${s.detail ? `<span class="qc-detail">${esc(s.detail)}</span>` : ''}</button>`).join('')}</div>
      <div class="reply">
        <input class="field" type="text" autocomplete="off" data-draft="${dk}" data-enter="q-next" data-id="${t.id}" value="${esc(S.drafts[dk] || '')}" aria-label="自己写第 ${d.at + 1} 题的回答" placeholder="或者自己写…">
        <button class="btn${busyCls(key)}" type="button" data-act="q-next" data-id="${t.id}"${busyAttr(key)}>${last ? '发送' : '下一题'}</button>
      </div>
    </div>`
  }

  function ticketRow(t) {
    if (!t) return ''
    return `<button class="trow" type="button" data-act="open-ticket" data-id="${t.id}">
      ${stateStatus(t.state)}
      <span class="od-fill"><span class="trow-title od-truncate">${esc(t.title)}</span><span class="trow-meta od-truncate"><span class="mono">${t.ref}</span> · ${esc(where(t))}</span></span>
      ${ic('chev')}
    </button>`
  }

  function convView() {
    const dest = S.dest
    const items = D.stream[dest]
    const dk = `compose-${dest}`
    const att = S.att[dest]
    const rail = dest === 'code' ? railView() : ''
    return `<div class="conv${rail ? '' : ' conv--solo'}">
      <div class="conv-main">
        <div class="conv-bar">
          <div class="seg" role="group" aria-label="对话去向">
            <button type="button" data-act="dest" data-dest="code" aria-pressed="${dest === 'code'}">${ic('repo', 16)}code</button>
            <button type="button" data-act="dest" data-dest="chat" aria-pressed="${dest === 'chat'}">${ic('chat', 16)}chat</button>
          </div>
          <span class="od-fill"></span>
          <span class="brain-chip"><span class="dot dot--ok"></span><span>大脑</span><span class="mono">${esc(D.hub.brain.model)}</span></span>
        </div>
        <div class="stream" data-scroll="stream"><div class="stream-inner" role="log" aria-label="${dest} 对话">
          ${items.map(it => streamItem(it, dest)).join('')}
        </div></div>
        <div class="composer-wrap">
          <div class="composer">
            ${att.length ? `<div class="att">${att.map((f, i) => `<span class="chip">${ic('clip')}<span>${esc(f)}</span><button type="button" data-act="att-remove" data-n="${i}" aria-label="移除 ${esc(f)}">${ic('x', 12)}</button></span>`).join('')}</div>` : ''}
            <textarea rows="1" data-draft="${dk}" data-grow data-enter="send" aria-label="发到 ${dest}" placeholder="${dest === 'code' ? '说说要做的仓库工作…' : '聊点什么，或者让它记住一件事…'}">${esc(S.drafts[dk] || '')}</textarea>
            <div class="composer-foot">
              <label class="icon-btn" title="添加附件">${ic('clip')}<span class="sr-only">添加附件</span><input class="sr-only" type="file" multiple data-change="att-add"></label>
              <span class="od-fill"></span>
              <button class="btn btn-primary btn-sm" type="button" data-act="send">${ic('send')}发送</button>
            </div>
          </div>
        </div>
      </div>
      ${rail}
    </div>`
  }

  function streamItem(it, dest) {
    switch (it.type) {
      case 'day': return `<div class="day">${esc(it.text)}</div>`
      case 'me': return `<div class="msg msg--me"><div class="msg-who"><span class="num">${esc(it.time)}</span></div><div class="msg-text">${para(it.text)}</div>${it.files?.length ? `<div class="msg-files">${it.files.map(f => `<span class="chip">${ic('clip')}${esc(f)}</span>`).join('')}</div>` : ''}</div>`
      case 'brain': return `<div class="msg msg--brain" data-msg="${it.id}"><div class="msg-who">${logo(16)}<strong>大脑</strong><span class="num">${esc(it.time)}</span></div><div class="msg-text${it.streaming ? ' cursor' : ''}">${it.pending ? typing : para(it.text)}</div></div>`
      case 'sys': return `<div class="sysline">${ic('check')}<span>${esc(it.text)}</span>${it.link ? `<button class="inline-link" type="button" data-act="dest" data-dest="${it.link}">去 ${it.link}</button>` : ''}</div>`
      case 'start': return startCard(startOf(it.ref))
      case 'plan': return planCard(planOf(it.ref))
      case 'ticket': return ticketRow(ticket(it.ref))
      default: return ''
    }
  }

  function railView() {
    const lines = waitingLines()
    const open = openTickets()
    return `<aside class="rail" aria-label="待办与工单">
      <section class="rail-sec">
        <div class="rail-head">${ic('inbox', 16)}<span>待办</span><span class="od-fill"><span class="count${lines.length ? ' count--hot' : ''}">${lines.length}</span></span></div>
        ${lines.length ? lines.slice(0, 5).map(railLine).join('') : '<p class="rail-empty">没有等你的事</p>'}
        ${lines.length > 5 ? `<button class="btn btn-ghost btn-sm" type="button" data-act="nav" data-view="inbox">全部 ${lines.length} 项</button>` : ''}
      </section>
      <section class="rail-sec">
        <div class="rail-head">${ic('ticket', 16)}<span>进行中的工单</span><span class="od-fill"><span class="count">${open.length}</span></span></div>
        ${open.length ? open.map(t => `<button class="rail-item" type="button" data-act="open-ticket" data-id="${t.id}"><span class="ri-title od-truncate">${esc(t.title)}</span><span class="ri-meta">${stateStatus(t.state)}<span class="mono od-truncate">${esc(t.machine)}</span></span></button>`).join('') : '<p class="rail-empty">没有进行中的工单</p>'}
      </section>
    </aside>`
  }
  const railLine = l => `<button class="rail-item" type="button" data-act="${l.act}" data-id="${l.id || ''}" data-view="${l.view || ''}"><span class="ri-title od-truncate">${esc(l.title)}</span><span class="ri-meta"><span class="dot dot--${l.tone}"></span><span>${l.kind}</span></span></button>`

  function inboxView() {
    const g = inbox()
    if (!g.total) return `<div class="page page--narrow"><div class="empty">${ic('check')}<strong>都处理完了</strong><span>有新的问题、开工请求或 PR 时会出现在这里，并通知你。</span><button class="btn" type="button" data-act="nav" data-view="conv">回到对话</button></div></div>`
    const sec = (title, n, body) => `<section class="section"><div class="section-head"><h2>${title}</h2><span class="count${n ? ' count--hot' : ''}">${n}</span></div>${body}</section>`
    const answer = g.answer.map(t => t.state === 'question' ? questionItem(t) : blockedItem(t)).join('')
    const confirm = g.confirm.map(({ k, x }) => (k === 'start' ? startCard(x) : k === 'plan' ? planCard(x) : pullCard(x))).join('')
    const optional = g.optional.map(candidateCard).join('')
    return `<div class="page page--narrow">
      ${g.answer.length ? sec('需要你回答', g.answer.length, `<div class="od-stack" style="--od-gap:16px">${answer}</div>`) : ''}
      ${g.confirm.length ? sec('需要你确认', g.confirm.length, `<div class="od-stack" style="--od-gap:16px">${confirm}</div>`) : ''}
      ${g.optional.length ? sec('手动派单', g.optional.length, `<div class="od-stack" style="--od-gap:16px">${optional}</div>`) : ''}
    </div>`
  }
  function itemHead(chip, t) {
    return `<div class="wcard-kind">${chip}<span class="chip chip--mono">${t.ref}</span><span class="od-fill mono">${esc(t.repo)}</span></div>`
  }
  function questionItem(t) {
    return `<article class="wcard" aria-labelledby="h-${t.id}">
      ${itemHead(status('warn', '等你回答'), t)}
      <h3 id="h-${t.id}">${esc(t.title)}</h3>
      ${questionCard(t)}
      <div class="card-actions"><span class="card-sub">${esc(where(t))}</span><span class="od-fill"></span><button class="btn btn-ghost btn-sm" type="button" data-act="open-ticket" data-id="${t.id}">打开工单 ${ic('chev')}</button></div>
    </article>`
  }
  function blockedItem(t) {
    return `<article class="wcard" aria-labelledby="h-${t.id}">
      ${itemHead(status('bad', '受阻'), t)}
      <h3 id="h-${t.id}">${esc(t.title)}</h3>
      <p class="reason">${esc(t.reason)}</p>
      ${t.repair ? `<p class="card-sub">自动修复：${esc(t.repair.state)} · ${esc(t.repair.note)}</p>` : ''}
      <div class="card-actions">
        <button class="btn btn-primary" type="button" data-act="reassign" data-id="${t.id}">${ic('swap')}改派</button>
        <button class="btn" type="button" data-act="open-ticket" data-id="${t.id}">打开工单</button>
        <span class="od-fill"></span>
        <button class="btn btn-danger" type="button" data-act="stop" data-id="${t.id}">${ic('stop')}停止</button>
      </div>
    </article>`
  }
  function pullCard(p) {
    const url = `https://github.com/${p.repo}/pull/${p.n}`
    const leftover = p.kind === 'leftover'
    return `<article class="wcard" aria-labelledby="h-${p.id}">
      <div class="wcard-kind"><span class="chip">${ic('pr')}PR</span><span class="chip chip--mono">${esc(p.repo)} #${p.n}</span><span class="od-fill num">${esc(p.time)}</span></div>
      <h3 id="h-${p.id}">${esc(p.title)}</h3>
      <p class="lede">${leftover ? `${esc(p.source)}，这个 PR 还开着。` : `已经等了 ${p.days} 天，还没合并。`}</p>
      <div class="card-actions">
        ${leftover
          ? `<button class="btn btn-danger" type="button" data-act="pull-close" data-id="${p.id}">关闭 PR</button><button class="btn btn-ghost" type="button" data-act="pull-keep" data-id="${p.id}">保留</button>`
          : `<a class="btn btn-primary" href="${url}" target="_blank" rel="noopener">去 GitHub 合并 ${ic('ext')}</a><button class="btn btn-ghost" type="button" data-act="pull-keep" data-id="${p.id}">再等一周</button>`}
        <span class="od-fill"></span><a class="card-sub mono" href="${url}" target="_blank" rel="noopener">${esc(p.ticket)}</a>
      </div>
    </article>`
  }
  function candidateCard(c) {
    const key = `cand:${c.id}`
    c.machine ||= 'pc'; c.engine ||= 'codex'; c.model ||= D.models.find(x => x.id === c.engine).model; c.effort ||= D.models.find(x => x.id === c.engine).effort
    return `<article class="wcard" aria-labelledby="h-${c.id}">
      <div class="wcard-kind"><span class="chip">${esc(c.source)}</span><span class="chip chip--warn">${esc(c.why)}</span><span class="od-fill num">${esc(c.time)}</span></div>
      <h3 id="h-${c.id}">${esc(c.title)}</h3>
      <p class="lede">${esc(c.text)}</p>
      ${whereSelects(c, 'cand-field', 'c', false)}
      ${errLine(key)}
      <div class="card-actions"><button class="btn btn-primary${busyCls(key)}" type="button" data-act="cand-go" data-id="${c.id}"${busyAttr(key)}>派出</button><button class="btn btn-ghost" type="button" data-act="cand-drop" data-id="${c.id}">忽略</button></div>
    </article>`
  }

  function ticketsView() {
    const q = (S.drafts['ticket-search'] || '').trim().toLowerCase()
    const open = D.tickets.filter(t => OPEN.has(t.state))
    const ended = D.tickets.filter(t => !OPEN.has(t.state))
    const base = S.ticketsTab === 'open' ? open : ended
    const list = q ? base.filter(t => [t.title, t.ref, t.repo, t.machine].some(v => v.toLowerCase().includes(q))) : base
    return `<div class="page">
      <div class="toolbar">
        <div class="seg" role="group" aria-label="工单筛选">
          <button type="button" data-act="tickets-tab" data-tab="open" aria-pressed="${S.ticketsTab === 'open'}">进行中 <span class="count">${open.length}</span></button>
          <button type="button" data-act="tickets-tab" data-tab="ended" aria-pressed="${S.ticketsTab === 'ended'}">已结束 <span class="count">${ended.length}</span></button>
        </div>
        <div class="search">${ic('search')}<input class="field" type="search" data-draft="ticket-search" data-live="tickets" value="${esc(S.drafts['ticket-search'] || '')}" aria-label="搜索工单" placeholder="标题、编号、仓库或机器"></div>
      </div>
      ${list.length ? `<div class="list">${list.map(t => `
        <button class="lrow" type="button" data-act="open-ticket" data-id="${t.id}">
          ${stateStatus(t.state)}
          <span class="lrow-main"><span class="lrow-title">${esc(t.title)}</span>
            <span class="lrow-meta"><span class="mono">${t.ref}</span><span>·</span><span class="mono">${esc(t.repo)}</span><span class="chip">${ic('machine')}${esc(where(t))}</span></span></span>
          <span class="lrow-side"><span class="num">${esc(t.updated)}</span>${t.pr ? `<span class="mono">PR #${t.pr}</span>` : ''}</span>
        </button>`).join('')}</div>`
        : q ? `<div class="empty">${ic('search')}<strong>没有匹配「${esc(q)}」的工单</strong><button class="btn" type="button" data-act="search-clear">清除搜索</button></div>`
          : `<div class="empty">${ic('check')}<strong>${S.ticketsTab === 'open' ? '没有进行中的工单' : '还没有结束的工单'}</strong></div>`}
    </div>`
  }

  function ticketView(t) {
    if (!t) return `<div class="page"><div class="empty"><strong>找不到这个工单</strong><button class="btn" type="button" data-act="nav" data-view="tickets">回到工单</button></div></div>`
    const open = OPEN.has(t.state)
    const [ciTone, ciLabel] = CI[t.ci] || CI.none
    const dk = `steer-${t.id}`
    const tl = t.timeline.map(e => {
      const cls = { worker: 'tl--worker', me: 'tl--me', ask: 'tl--ask', bad: 'tl--bad', ok: 'tl--ok' }[e.kind] || ''
      return `<li class="tl ${cls}"><span class="tl-rail"><span class="tl-dot"></span></span><div class="tl-body"><div class="tl-head"><strong>${esc(e.who)}</strong><span class="muted">${esc(e.time)}</span>${e.kind === 'ask' && t.state === 'question' ? '<span class="chip chip--warn">在问你</span>' : ''}</div><div class="tl-text">${esc(e.text)}</div></div></li>`
    }).join('')
    const live = t.state === 'working' ? `<li class="tl tl--live"><span class="tl-rail"><span class="tl-dot"></span></span><div class="tl-body"><div class="tl-head"><strong>${EN[t.engine]}</strong><span class="muted">工作中</span></div>${typing}</div></li>` : ''
    return `<div class="page">
      <div class="dhead">
        <button class="back" type="button" data-act="back" data-fallback="tickets">${ic('back')}工单</button>
        <div class="meta-row">${stateStatus(t.state)}<span class="chip chip--mono">${t.ref}</span><span class="chip chip--mono">${ic('repo')}${esc(t.repo)}</span></div>
        <h2>${esc(t.title)}</h2>
      </div>
      <div class="detail">
        <div>
          ${t.state === 'question' && t.questions ? `<div class="wcard" style="margin-bottom:24px">${questionCard(t)}</div>` : ''}
          ${t.state === 'blocked' ? `<p class="reason" style="margin-bottom:24px">${esc(t.reason)}</p>` : ''}
          ${t.state === 'queued' && t.waitNote ? `<p class="reason reason--warn" style="margin-bottom:24px">${esc(t.waitNote)}</p>` : ''}
          ${tl || live ? `<ol class="timeline" aria-label="时间线">${tl}${live}</ol>` : `<p class="muted">这个工单的记录已经归档。</p>`}
          ${open ? `<div class="steer">
            <label for="${dk}">对 ${EN[t.engine]} 说</label>
            <div class="reply"><textarea class="field" id="${dk}" rows="2" data-draft="${dk}" data-grow data-enter="steer" data-id="${t.id}" placeholder="补充要求，或者纠正方向…">${esc(S.drafts[dk] || '')}</textarea>
            <button class="btn btn-primary" type="button" data-act="steer" data-id="${t.id}" aria-label="发送">${ic('send')}</button></div>
            ${errLine(`steer:${t.id}`)}
          </div>` : ''}
        </div>
        <aside class="panel${S.panelOpen ? '' : ' is-collapsed'}" aria-label="工单状态">
          <div class="panel-sec panel-sec--summary">
            <div class="od-row">${stateStatus(t.state)}<span class="od-fill"></span><button class="btn btn-ghost btn-sm panel-toggle" type="button" data-act="panel-toggle" aria-expanded="${S.panelOpen}">${S.panelOpen ? '收起' : '详情'}</button></div>
            <dl class="kv"><dt>执行</dt><dd class="mono">${esc(where(t))}</dd><dt>CI</dt><dd>${status(ciTone, ciLabel, t.ci === 'running')}</dd></dl>
            ${open ? `<div class="panel-actions"><button class="btn btn-sm" type="button" data-act="reassign" data-id="${t.id}">${ic('swap')}改派</button><button class="btn btn-danger btn-sm" type="button" data-act="stop" data-id="${t.id}">${ic('stop')}停止</button></div>` : ''}
          </div>
          <div class="panel-sec"><h3>代码</h3><dl class="kv">
            <dt>分支</dt><dd class="mono">${esc(t.branch || '—')}</dd>
            <dt>PR</dt><dd>${t.pr ? `<a class="mono" href="https://github.com/${esc(t.repo)}/pull/${t.pr}" target="_blank" rel="noopener">#${t.pr}</a>` : '—'}</dd>
          </dl></div>
          <div class="panel-sec"><h3>执行</h3><dl class="kv">
            <dt>机器</dt><dd class="mono">${esc(t.machine)}</dd><dt>引擎</dt><dd>${EN[t.engine]}</dd>
            <dt>模型</dt><dd class="mono">${esc(t.model)}</dd><dt>强度</dt><dd class="mono">${esc(t.effort)}</dd>
          </dl></div>
          <div class="panel-sec"><h3>预审</h3><dl class="kv"><dt>状态</dt><dd>${esc(t.review.state)}</dd>${t.review.note ? `<dt>说明</dt><dd>${esc(t.review.note)}</dd>` : ''}</dl></div>
          ${t.repair ? `<div class="panel-sec"><h3>自动修复</h3><dl class="kv"><dt>状态</dt><dd>${esc(t.repair.state)}</dd><dt>位置</dt><dd class="mono">${esc(t.repair.host)} · ${esc(t.repair.engine)}</dd><dt>说明</dt><dd>${esc(t.repair.note)}</dd></dl></div>` : ''}
        </aside>
      </div>
    </div>`
  }

  function planView(p) {
    if (!p) return `<div class="page"><div class="empty"><strong>找不到这个计划</strong></div></div>`
    const viewing = S.planView[p.id] || p.version
    const old = viewing !== p.version
    const key = `plan:${p.id}`
    const revising = S.planRevise.has(p.id)
    const pending = p.status === 'pending'
    const t = p.ticket && ticket(p.ticket)
    const list = xs => `<ul>${xs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
    return `<div class="page">
      <div class="dhead">
        <button class="back" type="button" data-act="back" data-fallback="conv">${ic('back')}返回</button>
        <div class="meta-row">${planState(p)}<div class="versions" role="group" aria-label="版本">${p.versions.map(v => `<button class="btn btn-sm${v.v === viewing ? '' : ' btn-ghost'}" type="button" data-act="plan-ver" data-id="${p.id}" data-v="${v.v}" aria-pressed="${v.v === viewing}">v${v.v} <span class="num muted">${esc(v.at)}</span></button>`).join('')}</div></div>
        <h2>${esc(p.title)}</h2>
      </div>
      <div class="plan-grid">
        <div class="plan-doc">
          ${old ? `<p class="ver-note">你在看 v${viewing}。当前是 v${p.version}，确认只针对当前版本。</p>` : ''}
          <section><h3>目标</h3><p>${esc(p.goal)}</p></section>
          <section><h3>第一步</h3><p>${esc(p.first.scope)}</p></section>
          <section><h3>验收</h3><p>${esc(p.first.acceptance)}</p></section>
          <section><h3>之后</h3>${list(old ? p.backlog.slice(0, 2) : p.backlog)}</section>
          <section><h3>已定</h3>${list(old ? p.decisions.slice(0, 1) : p.decisions)}</section>
          ${p.open.length ? `<section><h3>待定</h3>${list(p.open)}</section>` : ''}
        </div>
        <aside class="plan-side" aria-label="开工设置">
          <dl class="kv"><dt>仓库</dt><dd class="mono">${esc(p.repo)}${p.isNew ? ' <span class="chip">新建</span>' : ''}</dd><dt>工作</dt><dd>${esc(p.work)}</dd><dt>平台</dt><dd>${esc(p.platform)}</dd></dl>
          <div class="form-row"><label for="pm-${p.id}">机器</label><select class="field" id="pm-${p.id}" data-change="plan-field" data-id="${p.id}" data-f="machine"${pending ? '' : ' disabled'}>${machineOptions(p.machine, false)}</select></div>
          <div class="form-row"><label for="pe-${p.id}">引擎</label><select class="field" id="pe-${p.id}" data-change="plan-field" data-id="${p.id}" data-f="engine"${pending ? '' : ' disabled'}>${engineOptions(p.engine)}</select></div>
          ${errLine(key)}
          ${t ? `<div class="done-line">${ic('check')}<span>已开工</span><button class="inline-link mono" type="button" data-act="open-ticket" data-id="${t.id}">${t.ref}</button></div>` : ''}
          ${pending ? `
            <button class="btn btn-primary${busyCls(key)}" type="button" data-act="plan-go" data-id="${p.id}"${p.revising || old ? ' disabled' : ''}${busyAttr(key)}>${ic('check')}开工</button>
            ${p.revising ? `<p class="card-sub">大脑正在写 v${p.version + 1} ${typing}</p>` : revising ? `
              <div class="form-row"><label for="pr-${p.id}">要改什么</label><textarea class="field" id="pr-${p.id}" rows="3" data-draft="revise-${p.id}" data-enter="plan-revise-send" data-id="${p.id}" placeholder="比如：HEIC 也转成 JPEG">${esc(S.drafts['revise-' + p.id] || '')}</textarea>${errLine('revise:' + p.id)}</div>
              <div class="card-actions"><button class="btn" type="button" data-act="plan-revise-send" data-id="${p.id}">发给大脑</button><button class="btn btn-ghost" type="button" data-act="plan-revise" data-id="${p.id}">取消</button></div>`
              : `<div class="card-actions"><button class="btn" type="button" data-act="plan-revise" data-id="${p.id}">${ic('compose')}改一下</button><button class="btn btn-ghost" type="button" data-act="plan-drop" data-id="${p.id}">不做了</button></div>`}` : ''}
        </aside>
      </div>
    </div>`
  }

  function memoryView() {
    const pend = pendingMemory()
    const tabs = `<div class="toolbar"><div class="seg" role="tablist" aria-label="记忆">
      <button type="button" role="tab" data-act="mem-tab" data-tab="mem" aria-selected="${S.memTab === 'mem'}">记忆${pend ? ` <span class="count count--hot">${pend}</span>` : ''}</button>
      <button type="button" role="tab" data-act="mem-tab" data-tab="sum" aria-selected="${S.memTab === 'sum'}">摘要</button></div></div>`
    if (S.memTab === 'sum') return `<div class="page page--narrow">${tabs}${summariesView()}</div>`
    const live = D.memory.filter(m => m.state !== 'rejected')
    const groups = [
      ['待确认', live.filter(m => m.state === 'pending')],
      ['长期记忆', live.filter(m => m.state === 'confirmed' && m.kind === 'memory')],
      ['身份', live.filter(m => m.state === 'confirmed' && m.kind === 'identity')],
      ['邮件偏好', live.filter(m => m.state === 'confirmed' && m.kind === 'mail_preference')],
    ].filter(([, xs]) => xs.length)
    const ed = S.memEditor
    return `<div class="page page--narrow">${tabs}
      ${ed && !ed.id ? `<div style="margin-bottom:32px">${memEditor()}</div>` : ''}
      ${groups.map(([title, xs]) => `<section class="section"><div class="section-head"><h2>${title}</h2><span class="count${title === '待确认' ? ' count--hot' : ''}">${xs.length}</span></div>
        <div class="mem-list">${xs.map(memRow).join('')}</div></section>`).join('')}
    </div>`
  }
  function memEditor() {
    const ed = S.memEditor
    return `<div class="editor">
      <label for="mem-edit">${ed.id ? '改写这条记忆' : '新记忆'}</label>
      <textarea class="field" id="mem-edit" rows="2" data-draft="mem-edit" data-enter="mem-save" maxlength="400"${ed.error ? ' aria-invalid="true" aria-describedby="mem-err"' : ''}>${esc(S.drafts['mem-edit'] ?? ed.text)}</textarea>
      ${ed.error ? `<p class="field-err" id="mem-err" role="alert">${esc(ed.error)}</p>` : ''}
      <div class="card-actions"><button class="btn btn-primary btn-sm${busyCls('mem')}" type="button" data-act="mem-save"${busyAttr('mem')}>保存</button><button class="btn btn-ghost btn-sm" type="button" data-act="mem-cancel">取消</button></div>
    </div>`
  }
  function memRow(m) {
    if (S.memEditor?.id === m.id) return `<div class="mrow" style="grid-template-columns:1fr">${memEditor()}</div>`
    const repl = (m.replaces || []).map(r => D.memory.find(x => x.id === r)).filter(x => x && x.state === 'confirmed')
    const src = m.source.startsWith('tkt_') ? `<span class="chip chip--mono">${esc(m.source)}</span>` : `<span class="chip">${esc(m.source)}</span>`
    return `<div class="mrow" data-mem="${m.id}">
      <div class="mrow-main"><p class="mrow-text">${esc(m.text)}</p>
        ${repl.length ? `<div class="mrow-replaces"><span>确认后替换：</span>${repl.map(r => `<s>${esc(r.text)}</s>`).join('')}</div>` : ''}
        <div class="mrow-meta">${src}<span class="num">${esc(m.at)}</span></div></div>
      <div class="mrow-actions">${m.state === 'pending'
        ? `<button class="btn btn-primary btn-sm" type="button" data-act="mem-confirm" data-id="${m.id}">确认</button><button class="btn btn-ghost btn-sm" type="button" data-act="mem-reject" data-id="${m.id}">不要</button>`
        : `<button class="icon-btn" type="button" data-act="mem-edit" data-id="${m.id}" aria-label="改写">${ic('compose')}</button><button class="icon-btn" type="button" data-act="mem-reject" data-id="${m.id}" aria-label="删除这条记忆">${ic('x')}</button>`}</div>
    </div>`
  }
  function summariesView() {
    const q = (S.drafts['sum-search'] || '').trim()
    const all = D.summaries.filter(s => S.showArchived || !s.archived)
    const list = q ? all.filter(s => (s.title + s.text).includes(q)) : all
    const archived = D.summaries.filter(s => s.archived).length
    return `<div class="toolbar"><div class="search">${ic('search')}<input class="field" type="search" data-draft="sum-search" data-live="memory" value="${esc(q)}" aria-label="搜索摘要" placeholder="搜索摘要"></div>
      ${archived ? `<button class="btn btn-ghost btn-sm" type="button" data-act="sum-arch" aria-pressed="${S.showArchived}">${S.showArchived ? '隐藏已归档' : `显示已归档（${archived}）`}</button>` : ''}</div>
      ${list.length ? `<div class="mem-list">${list.map(s => `<article class="sum"><div class="sum-head"><strong>${esc(s.title)}</strong><span class="num muted">${esc(s.range)}</span>${s.archived ? '<span class="chip">已归档</span>' : ''}</div><p>${para(s.text)}</p></article>`).join('')}</div>`
        : `<div class="empty">${ic('search')}<strong>没有匹配「${esc(q)}」的摘要</strong><button class="btn" type="button" data-act="sum-clear">清除搜索</button></div>`}`
  }

  function settingsView() {
    const sec = S.route.param
    const active = sec || 'machines'
    const nav = SECTIONS.map(g => `<div class="set-group"><p class="set-group-title">${g.group}</p><ul class="nav">${g.items.map(([k, n, icn]) => `
      <li><button class="nav-btn" type="button" data-act="nav" data-view="settings" data-param="${k}"${k === active ? ' aria-current="page"' : ''}>${ic(icn)}<span class="nav-label">${n}</span>${k === 'machines' ? `<span class="count">${D.machines.filter(m => m.connected).length}/${D.machines.length}</span>` : ''}</button></li>`).join('')}</ul></div>`).join('')
    const body = { machines: machinesSec, models: modelsSec, repos: reposSec, rules: rulesSec, notifications: notifySec, connections: connSec, appearance: appearanceSec, shortcuts: keysSec, files: filesSec }[active]
    return `<div class="page"><div class="settings${sec ? ' is-section' : ''}">
      <nav class="set-nav" aria-label="设置分区">${nav}</nav>
      <div class="set-body">
        <div class="od-row"><button class="back set-back" type="button" data-act="nav" data-view="settings">${ic('back')}设置</button></div>
        ${body()}
      </div>
    </div></div>`
  }
  const switchBtn = (on, act, attrs, label, disabled) => `<button class="switch" type="button" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}" data-act="${act}" ${attrs}${disabled ? ' disabled' : ''}></button>`
  const secHead = t => `<h2 class="set-title">${t}</h2>`

  function machinesSec() {
    const cards = D.machines.map(m => {
      const free = m.slots - m.running - m.idle
      const bar = Array.from({ length: m.slots }, (_, i) => `<i class="${i < m.running ? 'run' : i < m.running + m.idle ? 'idle' : ''}"></i>`).join('')
      return `<article class="mcard">
        <div class="mcard-head"><span class="dot ${m.connected ? 'dot--ok' : 'dot--mute'}"></span><span class="mcard-name od-fill od-truncate">${esc(m.id)}</span><span class="chip">${esc(m.os)}</span></div>
        <p class="card-sub">${esc(m.seen)}</p>
        <div class="slots"><div class="slot-bar" style="--n:${m.slots}" aria-hidden="true">${bar}</div>
          <div class="slot-legend"><span>运行 ${m.running}</span><span>空闲 ${m.idle}</span><span>可用 ${free}</span></div></div>
        <div class="meta-row">${m.engines.map(e => `<span class="chip">${EN[e]}</span>`).join('')}</div>
        <div class="meta-row">${m.labels.map(l => `<span class="chip chip--mono">${esc(l)}</span>`).join('')}</div>
        <div class="card-actions"><span class="od-fill"></span><button class="btn btn-danger btn-sm" type="button" data-act="machine-revoke" data-id="${m.id}">撤销</button></div>
      </article>`
    }).join('')
    const nameErr = S.errors['machine-name']
    return `${secHead('机器')}
      <div class="machines">${cards}</div>
      <section class="section"><div class="section-head"><h2>添加机器</h2></div>
        <div class="card card-pad od-stack" style="--od-gap:16px">
          <div class="mk-row">
            <div class="form-row"><label for="mname">机器名</label><input class="field mono" id="mname" type="text" autocomplete="off" data-draft="machine-name" data-enter="machine-make" value="${esc(S.drafts['machine-name'] || '')}" placeholder="studio-pc"${nameErr ? ' aria-invalid="true" aria-describedby="mname-err"' : ''}></div>
            <div class="form-row"><span class="label" id="mos">系统</span><div class="seg" role="group" aria-labelledby="mos">${['Windows', 'macOS'].map(o => `<button type="button" data-act="machine-os" data-os="${o}" aria-pressed="${S.machineOs === o}">${o}</button>`).join('')}</div></div>
          </div>
          ${nameErr ? `<p class="field-err" id="mname-err" role="alert">${esc(nameErr)}</p>` : ''}
          <div class="card-actions"><button class="btn btn-primary${busyCls('machine')}" type="button" data-act="machine-make"${busyAttr('machine')}>生成安装命令</button></div>
          ${S.machineCmd ? `<div class="cmd"><code>${esc(S.machineCmd)}</code><button class="icon-btn" type="button" data-act="copy" data-text="${esc(S.machineCmd)}" aria-label="复制命令">${ic('copy')}</button></div>
            <p class="card-sub">在新机器上运行一次。安装码 10 分钟内有效，只能用一次。</p>` : ''}
        </div></section>`
  }
  function modelsSec() {
    return `${secHead('模型')}<div class="rows">${D.models.map(m => {
      const d = S.modelDrafts[m.id] || {}
      const mo = d.model || m.model, ef = d.effort || m.effort
      const dirty = mo !== m.model || ef !== m.effort
      const k = `model:${m.id}`
      return `<div class="srow"><div class="srow-text"><span class="srow-title">${esc(m.name)}</span><span class="srow-help mono">${esc(m.model)} · ${esc(m.effort)}</span></div>
        <div class="srow-ctl">
          <select class="field" style="width:auto" data-change="model-field" data-id="${m.id}" data-f="model" aria-label="${esc(m.name)} 的模型"${m.models.length < 2 ? ' disabled' : ''}>${m.models.map(x => `<option${x === mo ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>
          <select class="field" style="width:auto" data-change="model-field" data-id="${m.id}" data-f="effort" aria-label="${esc(m.name)} 的推理强度"${m.efforts.length < 2 ? ' disabled' : ''}>${m.efforts.map(x => `<option${x === ef ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>
          <button class="btn btn-sm${dirty ? ' btn-primary' : ''}${busyCls(k)}" type="button" data-act="model-save" data-id="${m.id}"${dirty ? '' : ' disabled'}${busyAttr(k)}>保存</button>
        </div></div>`
    }).join('')}</div>`
  }
  function reposSec() {
    const sw = (r, f, label) => `<span class="switch-label">${switchBtn(r[f], 'repo-toggle', `data-id="${esc(r.name)}" data-f="${f}"`, `${r.name} ${label}`)}${label}</span>`
    return `${secHead('仓库')}<div class="rows">${D.repos.map(r => `<div class="srow">
      <div class="srow-text"><span class="srow-title mono">${esc(r.name)}</span><span class="srow-help">${esc(r.work)}</span></div>
      <div class="srow-ctl od-cluster" style="--od-gap:16px">${sw(r, 'watch', '监视 issue')}${sw(r, 'review', '预审')}${sw(r, 'merge', '自动合并')}</div>
    </div>`).join('')}</div>`
  }
  function rulesSec() {
    const r = D.rules
    return `${secHead('规则')}<div class="rows">
      <div class="srow"><div class="srow-text"><span class="srow-title">安静时段</span><span class="srow-help">期间的通知攒成一条，结束后发给你</span></div>
        <div class="srow-ctl"><input class="field time-in mono" type="time" value="${r.quietFrom}" data-change="rule-time" data-f="quietFrom" aria-label="开始"${r.quiet ? '' : ' disabled'}><span class="muted">–</span><input class="field time-in mono" type="time" value="${r.quietTo}" data-change="rule-time" data-f="quietTo" aria-label="结束"${r.quiet ? '' : ' disabled'}>${switchBtn(r.quiet, 'rule-toggle', 'data-f="quiet"', '安静时段')}</div></div>
      <div class="srow"><div class="srow-text"><span class="srow-title">每日 issue 摘要</span></div>
        <div class="srow-ctl"><input class="field time-in mono" type="time" value="${r.digestAt}" data-change="rule-time" data-f="digestAt" aria-label="发送时间"${r.digest ? '' : ' disabled'}>${switchBtn(r.digest, 'rule-toggle', 'data-f="digest"', '每日 issue 摘要')}</div></div>
      <div class="srow"><div class="srow-text"><span class="srow-title">合并</span></div>
        <div class="srow-ctl"><div class="seg" role="group" aria-label="合并方式"><button type="button" data-act="rule-merge" data-v="1" aria-pressed="${r.mergeAll}">全部自动</button><button type="button" data-act="rule-merge" data-v="0" aria-pressed="${!r.mergeAll}">按仓库</button></div></div></div>
      <div class="srow"><div class="srow-text"><span class="srow-title">开工前预审 issue</span></div><div class="srow-ctl">${switchBtn(r.reviewIssues, 'rule-toggle', 'data-f="reviewIssues"', '开工前预审 issue')}</div></div>
      <div class="srow"><div class="srow-text"><span class="srow-title">默认分支 CI 变红时告诉我</span></div><div class="srow-ctl">${switchBtn(r.watchCI, 'rule-toggle', 'data-f="watchCI"', '默认分支 CI 变红时告诉我')}</div></div>
    </div>`
  }
  function notifySec() {
    const me = D.devices.find(d => d.self)
    const groups = [['need', '需要我'], ['done', '完成'], ['personal', '个人']]
    return `${secHead('通知')}
      <section class="section"><div class="section-head"><h2>这个浏览器</h2></div><div class="rows">
        <div class="srow"><div class="srow-text"><span class="srow-title">接收通知</span></div><div class="srow-ctl">${switchBtn(me?.on, 'notify-self', '', '这个浏览器接收通知', S.busy.has('notify'))}</div></div>
        ${groups.map(([k, n]) => `<div class="srow"><div class="srow-text"><span class="srow-title">${n}</span></div><div class="srow-ctl">${switchBtn(me?.groups[k], 'notify-group', `data-id="${me?.id}" data-f="${k}"`, n, !me?.on)}</div></div>`).join('')}
      </div></section>
      <section class="section"><div class="section-head"><h2>所有设备</h2><span class="count">${D.devices.length}</span></div><div class="rows">
        ${D.devices.map(d => `<div class="srow"><span class="dot ${d.on ? 'dot--ok' : 'dot--mute'}"></span><div class="srow-text"><span class="srow-title">${esc(d.name)}</span><span class="srow-help">${esc(d.kind)} · ${d.on ? groups.filter(([k]) => d.groups[k]).map(([, n]) => n).join('、') || '全部关闭' : '未开启'}</span></div>
          <div class="srow-ctl"><button class="btn btn-sm" type="button" data-act="notify-test" data-id="${d.id}"${d.on ? '' : ' disabled'}>测试</button>${d.self ? '' : `<button class="btn btn-danger btn-sm" type="button" data-act="device-revoke" data-id="${d.id}">撤销</button>`}</div></div>`).join('')}
      </div></section>`
  }
  function connSec() {
    const c = D.connections
    const row = (title, help, dot, ctl = '') => `<div class="srow"><span class="dot dot--${dot}"></span><div class="srow-text"><span class="srow-title">${title}</span><span class="srow-help">${help}</span></div><div class="srow-ctl">${ctl}</div></div>`
    const revoke = (kind, x) => row(esc(x.name), `${esc(x.kind)} · ${esc(x.since)} 起`, 'ok', `<button class="btn btn-danger btn-sm" type="button" data-act="conn-revoke" data-kind="${kind}" data-id="${x.id}">撤销</button>`)
    const empty = t => `<div class="srow"><span class="srow-help">${t}</span></div>`
    return `${secHead('连接')}
      <section class="section"><div class="section-head"><h2>服务</h2></div><div class="rows">
        ${row('Lark', esc(c.lark.note), 'ok')}
        ${c.github.map(g => row(`GitHub · <span class="mono">${esc(g.login)}</span>`, esc(g.note), 'ok')).join('')}
        ${row('大脑', `<span class="mono">${esc(D.hub.brain.model)} · ${esc(D.hub.brain.effort)}</span>`, D.hub.brain.online ? 'ok' : 'bad')}
        ${row('审阅者', esc(c.reviewer.note), 'ok')}
      </div></section>
      <section class="section"><div class="section-head"><h2>客户端</h2><span class="count">${c.clients.length + c.bridges.length}</span></div><div class="rows">
        ${c.clients.map(x => revoke('clients', x)).join('')}${c.bridges.map(x => revoke('bridges', x)).join('')}
        ${c.clients.length + c.bridges.length ? '' : empty('没有已授权的客户端')}
      </div></section>
      <section class="section"><div class="section-head"><h2>桌面设备</h2><span class="count">${c.desktops.length}</span><span class="od-fill"></span><button class="btn btn-sm" type="button" data-act="pair">${ic('plus')}添加设备</button></div>
        ${S.pairing ? `<div class="card card-pad od-stack" style="--od-gap:12px"><span class="label">在新设备的 Super-agent 里输入配对码</span>
          <div class="cmd"><code>${esc(S.pairing)}</code><button class="icon-btn" type="button" data-act="copy" data-text="${esc(S.pairing)}" aria-label="复制配对码">${ic('copy')}</button></div>
          <p class="card-sub">10 分钟内有效，只能用一次。</p></div>` : ''}
        <div class="rows">${c.desktops.map(x => revoke('desktops', x)).join('') || empty('没有配对的桌面设备')}</div></section>`
  }
  function appearanceSec() {
    const opts = [['system', '跟随系统', 'auto'], ['light', '浅色', 'light'], ['dark', '深色', 'dark']]
    const preset = ACCENTS.some(([c]) => c === S.accent.toLowerCase())
    return `${secHead('外观')}
      <section class="section"><div class="section-head"><h2>主题</h2></div>
        <div class="theme-choices" role="radiogroup" aria-label="主题">${opts.map(([v, n, sw]) => `
          <button class="theme-opt" type="button" role="radio" aria-checked="${S.theme === v}" data-act="theme" data-v="${v}"><span class="theme-swatch theme-swatch--${sw}"></span><span class="theme-name">${n}</span></button>`).join('')}</div></section>
      <section class="section"><div class="section-head"><h2>重点色</h2></div>
        <div class="accents" role="radiogroup" aria-label="重点色">${ACCENTS.map(([c, n]) => `
          <button class="accent-opt" type="button" role="radio" aria-checked="${S.accent.toLowerCase() === c}" aria-label="${n}" title="${n}" data-act="accent" data-v="${c}" style="--sw:${c}"><i></i></button>`).join('')}
          <label class="accent-custom" data-on="${!preset}"><input type="color" value="${esc(S.accent)}" data-change="accent-custom" data-accent-live aria-label="自定义重点色">自定义</label>
        </div>
        <div class="accent-preview" aria-hidden="true"><span class="btn btn-primary btn-sm">${ic('check')}开始</span><span class="count count--hot">3</span><span class="mono" style="color:var(--meta)">tkt_7f3a21c0</span><span class="dot dot--accent"></span></div>
      </section>`
  }
  function keysSec() {
    const rows = [['tray', '呼出托盘'], ['main', '呼出主界面']]
    return `${secHead('快捷键')}<div class="rows">${rows.map(([k, n]) => {
      const keys = D.shortcuts[k]
      const rec = S.recording === k
      return `<div class="srow"><div class="srow-text"><span class="srow-title">${n}</span>${S.keyNote[k] ? `<span class="srow-help" role="status">${esc(S.keyNote[k])}</span>` : ''}</div>
        <div class="srow-ctl">${rec ? '<span class="recording" role="status">按下新的组合键，Esc 取消</span>' : keys ? `<span class="keys">${keys.map(x => `<span class="kbd">${esc(x)}</span>`).join('')}</span>` : '<span class="muted">未设置</span>'}
          <button class="btn btn-sm${rec ? ' btn-primary' : ''}" type="button" data-act="key-rec" data-id="${k}">${rec ? '取消' : '录制'}</button>
          <button class="btn btn-ghost btn-sm" type="button" data-act="key-clear" data-id="${k}"${keys && !rec ? '' : ' disabled'}>清除</button></div></div>`
    }).join('')}</div>
    <div><button class="btn" type="button" data-act="nav" data-view="tray">${ic('tray')}看托盘弹窗</button></div>`
  }
  function filesSec() {
    const files = [...D.files].sort((a, b) => S.filesSort === 'size' ? b.size - a.size : 0)
    return `${secHead('文件')}
      <div class="toolbar" style="margin:0"><div class="seg" role="group" aria-label="排序"><button type="button" data-act="files-sort" data-v="date" aria-pressed="${S.filesSort === 'date'}">按时间</button><button type="button" data-act="files-sort" data-v="size" aria-pressed="${S.filesSort === 'size'}">按大小</button></div>
      <span class="muted num">${size(D.files.reduce((n, f) => n + f.size, 0))}</span></div>
      <div class="rows">${files.map(f => `<div class="srow">${ic('doc', 18)}<div class="srow-text"><span class="srow-title mono od-truncate">${esc(f.name)}</span><span class="srow-help">${esc(f.at)}</span></div><div class="srow-ctl"><span class="chip">${f.where}</span><span class="num muted od-nowrap">${size(f.size)}</span></div></div>`).join('')}</div>`
  }

  function trayView() {
    const lines = waitingLines()
    const turns = D.stream.code.filter(it => it.type !== 'day').slice(-20)
    const dk = 'tray'
    return `<div class="tray-stage">
      <div class="taskbar"><span>${clock()}</span><button class="tray-icon" type="button" data-act="tray-toggle" aria-expanded="${S.trayOpen}" aria-label="Super-agent，${lines.length} 项待办">${logo(18)}${lines.length ? `<span class="badge">${lines.length}</span>` : ''}</button></div>
      <section class="tray${S.trayOpen ? '' : ' is-closed'}" aria-label="Super-agent 托盘">
        <div class="tray-head">${logo(18)}<strong>Super-agent</strong><span class="dot dot--ok" aria-label="中枢在线"></span><span class="od-fill"></span><button class="icon-btn" type="button" data-act="nav" data-view="conv" aria-label="打开主界面">${ic('ext')}</button></div>
        ${lines.length ? `<div class="tray-wait">${lines.slice(0, 3).map(l => `<button type="button" data-act="${l.act}" data-id="${l.id || ''}" data-view="${l.view || ''}"><span class="dot dot--${l.tone}"></span><span class="muted">${l.kind}</span><span class="od-fill od-truncate">${esc(l.title)}</span>${ic('chev', 14)}</button>`).join('')}</div>` : '<div></div>'}
        <div class="tray-turns" data-scroll="tray">${turns.map(trayTurn).join('')}</div>
        <div class="tray-input"><textarea rows="1" data-draft="${dk}" data-grow data-enter="tray-send" aria-label="交给中枢" placeholder="交给中枢…">${esc(S.drafts[dk] || '')}</textarea><button class="btn btn-primary" type="button" data-act="tray-send" aria-label="发送" style="width:40px;padding:0">${ic('send')}</button></div>
      </section>
    </div>`
  }
  function trayTurn(it) {
    if (it.type === 'me') return `<div class="msg msg--me"><div class="msg-text clamp-6">${esc(it.text)}</div></div>`
    if (it.type === 'brain') return `<div class="msg msg--brain" data-msg="${it.id}"><div class="msg-who">${logo(14)}<span class="num">${esc(it.time)}</span></div><div class="msg-text clamp-6${it.streaming ? ' cursor' : ''}">${it.pending ? typing : esc(it.text)}</div></div>`
    if (it.type === 'ticket') { const t = ticket(it.ref); return t ? `<button class="mini" type="button" data-act="open-ticket" data-id="${t.id}">${stateStatus(t.state)}<span class="od-fill od-truncate">${esc(t.title)}</span></button>` : '' }
    if (it.type === 'start') { const s = startOf(it.ref); return s ? `<button class="mini" type="button" data-act="nav" data-view="inbox">${status(s.status ? 'ok' : 'info', s.status ? '已开工' : '开工请求')}<span class="od-fill od-truncate">${esc(s.title)}</span></button>` : '' }
    if (it.type === 'plan') { const p = planOf(it.ref); return p ? `<button class="mini" type="button" data-act="open-plan" data-id="${p.id}">${planState(p)}<span class="od-fill od-truncate">${esc(p.title)}</span></button>` : '' }
    if (it.type === 'sys') return `<div class="sysline">${ic('check')}<span>${esc(it.text)}</span></div>`
    return ''
  }

  const TITLE = { conv: '对话', inbox: '待办', tickets: '工单', ticket: '工单', plan: '计划', memory: '记忆', settings: '设置', tray: '托盘弹窗' }
  function renderChrome() {
    const cur = navOf(S.route.view)
    const navBtn = n => { const c = n.count ? n.count() : 0; return `<li><button class="nav-btn" type="button" data-act="nav" data-view="${n.view}"${cur === n.view ? ' aria-current="page"' : ''}>${ic(n.icon)}<span class="nav-label">${n.label}</span>${c ? `<span class="count${n.hot ? ' count--hot' : ''}">${c}</span>` : ''}</button></li>` }
    $('[data-slot="nav"]').innerHTML = NAV.map(navBtn).join('')
    $('[data-slot="nav-foot"]').innerHTML = NAV_FOOT.map(navBtn).join('')
    $('[data-slot="tabbar"]').innerHTML = TABS.map(n => { const c = n.hot && n.count ? n.count() : 0; return `<button class="tab" type="button" data-act="nav" data-view="${n.view}"${cur === n.view ? ' aria-current="page"' : ''}><span>${ic(n.icon)}</span><span>${n.label}</span>${c ? `<span class="tab-badge">${c}</span>` : ''}</button>` }).join('')
    $('[data-slot="hub"]').innerHTML = `<div class="hub-line"><span class="dot dot--ok"></span><span>中枢</span><span class="od-fill">在线</span></div>
      <div class="hub-line"><span class="dot ${D.hub.brain.online ? 'dot--ok' : 'dot--bad'}"></span><span>大脑</span><span class="od-fill">${esc(D.hub.brain.model)}</span></div>
      <div class="hub-line"><span class="dot dot--ok"></span><span>机器</span><span class="od-fill">${D.machines.filter(m => m.connected).length} / ${D.machines.length}</span></div>`
    const v = S.route.view
    const sub = v === 'settings' && S.route.param ? `<span class="muted">/</span><span class="muted" style="font-size:var(--text-lg)">${SECTION_NAME[S.route.param]}</span>` : ''
    $('[data-slot="title"]').innerHTML = `<h1>${TITLE[v]}</h1>${sub}`
    $('[data-slot="top-actions"]').innerHTML = v === 'memory' && S.memTab === 'mem' ? `<button class="btn btn-sm" type="button" data-act="mem-new">${ic('plus')}新记忆</button>` : ''
  }
  function render(opts = {}) {
    applyTheme()
    const main = $('#main')
    const viewKey = `${S.route.view}/${S.route.param || ''}/${S.dest}/${S.memTab}`
    const same = main.dataset.view === viewKey
    const a = document.activeElement
    const focusKey = a?.dataset?.draft
    const sel = focusKey && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null
    const scrolls = {}
    $$('[data-scroll]', main).forEach(el => { scrolls[el.dataset.scroll] = { top: el.scrollTop, bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 40 } })
    const mainTop = main.scrollTop

    renderChrome()
    const v = S.route.view
    main.classList.toggle('is-fill', v === 'conv')
    main.innerHTML = v === 'conv' ? convView() : v === 'inbox' ? inboxView() : v === 'tickets' ? ticketsView() : v === 'ticket' ? ticketView(ticket(S.route.param))
      : v === 'plan' ? planView(planOf(S.route.param)) : v === 'memory' ? memoryView() : v === 'settings' ? settingsView() : trayView()
    main.dataset.view = viewKey

    if (same && !opts.top) main.scrollTop = mainTop
    else main.scrollTop = 0
    $$('[data-scroll]', main).forEach(el => {
      const was = scrolls[el.dataset.scroll]
      if (!same || opts.toBottom || !was || was.bottom) el.scrollTop = el.scrollHeight
      else el.scrollTop = was.top
    })
    $$('textarea[data-grow]', main).forEach(grow)
    if (S.focusSel) { const f = $(S.focusSel); S.focusSel = null; if (f) { f.focus({ preventScroll: false }); return } }
    if (focusKey && same) {
      const f = main.querySelector(`[data-draft="${CSS.escape(focusKey)}"]`)
      if (f) { f.focus({ preventScroll: true }); if (sel) try { f.setSelectionRange(sel[0], sel[1]) } catch {  } }
    }
  }
  function grow(t) {
    t.style.height = 'auto'
    const max = t.closest('.tray-input') ? 6 * 1.55 * 14 + 20 : 200
    t.style.height = Math.min(t.scrollHeight + 2, max) + 'px'
  }

  function toast(text, opt = {}) {
    const box = $('[data-slot="toasts"]')
    const el = document.createElement('div')
    el.className = `toast${opt.bad ? ' toast--bad' : ''}`
    el.innerHTML = `${ic(opt.bad ? 'alert' : 'check')}<span>${esc(text)}</span>${opt.label ? `<button type="button">${esc(opt.label)}</button>` : ''}`
    if (opt.label) el.querySelector('button').addEventListener('click', () => { leave(); opt.fn() })
    box.appendChild(el)
    const leave = () => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 160) }
    setTimeout(leave, 4200)
  }
  let returnSel = null
  function openDialog(dlg, html, back) {
    returnSel = back
    dlg.innerHTML = html
    dlg.showModal()
    requestAnimationFrame(() => (dlg.querySelector('[autofocus]') || dlg.querySelector('button, input, textarea'))?.focus())
  }
  function closeDialog(dlg) {
    if (!dlg.open) return
    dlg.classList.add('is-leaving')
    setTimeout(() => { dlg.classList.remove('is-leaving'); dlg.close() }, 150)
  }
  $$('dialog').forEach(d => d.addEventListener('close', () => {
    const f = returnSel && $(returnSel)
    ;(f || $('#main')).focus()
    returnSel = null
  }))
  let onConfirm = null
  function confirmBox({ title, text, ok, danger = true, back, fn }) {
    onConfirm = fn
    openDialog($('#dlg-confirm'), `<div class="dlg-in">
      <div class="dlg-head"><h2 id="confirm-title">${esc(title)}</h2></div>
      ${text ? `<p class="dlg-text">${esc(text)}</p>` : ''}
      <div class="dlg-actions"><button class="btn btn-ghost" type="button" data-act="dlg-close" autofocus>取消</button><button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" type="button" data-act="confirm-ok">${esc(ok)}</button></div>
    </div>`, back)
  }

  function openReassign(t, back) {
    S.reassign = { id: t.id, choice: null }
    const opts = D.machines.flatMap(m => m.engines.map(e => ({ m, e })))
    openDialog($('#dlg-reassign'), `<div class="dlg-in">
      <div class="dlg-head"><h2 id="reassign-title">改派 ${esc(t.ref)}</h2><button class="icon-btn" type="button" data-act="dlg-close" aria-label="关闭">${ic('x')}</button></div>
      <p class="dlg-text">${esc(t.title)}。分支、PR 和已有的改动会保留。</p>
      <div class="radio-list" role="radiogroup" aria-label="机器与引擎">${opts.map(({ m, e }) => {
        const cur = m.id === t.machine && e === t.engine
        return `<label class="radio"><input type="radio" name="reassign" value="${m.id}|${e}"${m.connected && !cur ? '' : ' disabled'}>
          <span class="radio-text"><span class="radio-title mono">${esc(m.id)} · ${EN[e]}</span><span class="radio-help">${!m.connected ? esc(m.seen) : cur ? '当前' : `可用 ${m.slots - m.running - m.idle} 个位置`}</span></span></label>`
      }).join('')}</div>
      <p class="field-err" data-slot="reassign-err" role="alert" hidden></p>
      <div class="dlg-actions"><button class="btn btn-ghost" type="button" data-act="dlg-close">取消</button><button class="btn btn-primary" type="button" data-act="reassign-ok">改派</button></div>
    </div>`, back)
  }

  function pickMachine(engine, wanted, needMac) {
    if (wanted && wanted !== '自动') return D.machines.find(m => m.id === wanted)
    const fit = D.machines.filter(m => m.connected && m.engines.includes(engine) && (!needMac || m.os === 'macOS'))
    return fit.sort((a, b) => (b.slots - b.running - b.idle) - (a.slots - a.running - a.idle))[0]
  }
  function newTicket({ title, repo, machine, engine, model, effort }) {
    const ref = `tkt_${rand8()}`
    const time = clock()
    const m = D.machines.find(x => x.id === machine)
    if (m) m.running += 1
    const t = { id: id('t'), ref, title, repo, state: 'working', machine, engine, model, effort, branch: `agent/${ref}`, pr: null, ci: 'none', review: { state: '进行中', note: '' }, updated: time, day: '今天',
      timeline: [{ kind: 'start', time, who: '中枢', text: `开工：在 ${machine} 上用 ${EN[engine]} 处理。` }] }
    D.tickets.unshift(t)
    D.stream.code.push({ id: id('a'), type: 'ticket', ref: t.id, time })
    setTimeout(() => { t.review = { state: '已通过', note: '' }; t.timeline.push({ kind: 'review', time: clock(), who: '审阅者', text: '预审通过。' }); render() }, 2600)
    setTimeout(() => { t.pr = 342 + Math.floor(Math.random() * 20); t.ci = 'running'; t.timeline.push({ kind: 'worker', time: clock(), who: EN[engine], text: '已读完相关代码，开始改动。' }); render() }, 6000)
    return t
  }
  function brainReply(dest, text, after) {
    const it = { id: id('r'), type: 'brain', time: clock(), text: '', pending: true }
    D.stream[dest].push(it)
    render({ toBottom: true })
    setTimeout(() => {
      it.pending = false; it.streaming = true
      let i = 0
      const timer = setInterval(() => {
        i = Math.min(text.length, i + 3)
        it.text = text.slice(0, i)
        const el = $(`[data-msg="${it.id}"] .msg-text`)
        if (el) { el.innerHTML = el.classList.contains('clamp-6') ? esc(it.text) : para(it.text); el.classList.remove('cursor'); el.classList.add('cursor'); const sc = el.closest('[data-scroll]'); if (sc) sc.scrollTop = sc.scrollHeight } else if (i === 3) render({ toBottom: true })
        if (i >= text.length) { clearInterval(timer); it.streaming = false; after?.(); render({ toBottom: true }) }
      }, 28)
    }, 650)
  }
  function say(dest, raw, files = []) {
    const text = raw.trim()
    if (!text && !files.length) return false
    const time = clock()
    D.stream[dest].push({ id: id('m'), type: 'me', time, text: text || '（附件）', files })
    const remember = text.match(/^(?:请|帮我)?记住[:：]?\s*(.+)$/)
    if (remember) {
      D.memory.unshift({ id: id('mm'), kind: 'memory', state: 'confirmed', text: remember[1], source: '对话', at: '今天' })
      D.stream[dest].push({ id: id('s'), type: 'sys', time, text: `已记住：${remember[1]}` })
      render({ toBottom: true })
      return true
    }
    if (dest === 'code') {
      brainReply('code', '这是仓库工作。我按规则排好了机器和引擎，开工卡在下面，确认后开始。', () => {
        const s = { id: id('s'), kind: 'single', title: shorten(text || '处理附件里的问题', 30), repo: 'novan-xu/super-agent', time: clock(), summary: text || '见附件。', items: [], machine: '自动', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' }
        D.starts.push(s)
        D.stream.code.push({ id: id('a'), type: 'start', ref: s.id, time: s.time })
      })
    } else {
      brainReply('chat', /提醒/.test(text) ? `已加到 TickTick 收件箱：${text.replace(/^提醒我/, '')}。` : '好的。需要我做具体的事，直接说就行。')
    }
    return true
  }
  function finishAnswers(t, answers) {
    const time = clock()
    t.timeline.push({ kind: 'me', time, who: '你', text: answers.map((a, i) => `${i + 1}. ${a}`).join('\n') })
    t.state = 'working'; t.updated = time
    delete t.questions; delete S.q[t.id]
    toast(`回答已发给 ${EN[t.engine]}`)
    setTimeout(() => { t.timeline.push({ kind: 'worker', time: clock(), who: EN[t.engine], text: '收到，按你的选择继续。' }); render() }, 1800)
  }

  const A = {
    nav: el => { const v = el.dataset.view; if (!v) return; if (S.route.view === 'settings' && v === 'settings' && !el.dataset.param) { go('settings') } else go(v, el.dataset.param || undefined) },
    back: el => { const p = S.prev; if (p && p.view !== S.route.view) go(p.view, p.param); else go(el.dataset.fallback) },
    'open-ticket': el => go('ticket', el.dataset.id),
    'open-plan': el => go('plan', el.dataset.id),
    dest: el => { S.dest = el.dataset.dest; if (S.route.view !== 'conv') go('conv'); else render({ toBottom: true }) },
    'dlg-close': el => closeDialog(el.closest('dialog')),
    'confirm-ok': el => { const fn = onConfirm; onConfirm = null; closeDialog(el.closest('dialog')); fn?.() },

    send: () => {
      const dk = `compose-${S.dest}`
      if (!say(S.dest, S.drafts[dk] || '', S.att[S.dest])) { S.focusSel = `[data-draft="${dk}"]`; render(); return }
      S.drafts[dk] = ''; S.att[S.dest] = []
      S.focusSel = `[data-draft="${dk}"]`
      render({ toBottom: true })
    },
    'att-remove': el => { S.att[S.dest].splice(+el.dataset.n, 1); render() },
    'tray-toggle': () => { S.trayOpen = !S.trayOpen; render() },
    'tray-send': () => { if (say('code', S.drafts.tray || '')) { S.drafts.tray = ''; S.focusSel = '[data-draft="tray"]'; render({ toBottom: true }) } },

    'start-tick': el => { const s = startOf(el.dataset.id); s.items[+el.dataset.n].off = !el.checked; S.focusSel = `[data-act="start-tick"][data-id="${s.id}"][data-n="${el.dataset.n}"]`; render() },
    'start-go': el => {
      const s = startOf(el.dataset.id), key = `start:${s.id}`
      const needMac = s.items.some(i => !i.off && i.label === 'macos')
      const m = pickMachine(s.engine, s.machine, needMac)
      delete S.errors[key]
      if (!m || !m.engines.includes(s.engine)) { S.errors[key] = `${m ? m.id : '没有在线的机器'}${m ? ` 上没有 ${EN[s.engine]}` : ''}。换一台机器或换个引擎。`; render(); return }
      if (needMac && m.os !== 'macOS') { S.errors[key] = `#${s.items.find(i => i.label === 'macos').n} 只能在 macOS 上做，选 mac-mini 或自动。`; render(); return }
      S.busy.add(key); render()
      setTimeout(() => {
        S.busy.delete(key)
        const picked = s.items.filter(i => !i.off)
        const t = newTicket({ title: picked.length ? (picked.length > 1 ? `${s.title}：${picked.length} 个 issue` : picked[0].title) : s.title, repo: s.repo, machine: m.id, engine: s.engine, model: s.model, effort: s.effort })
        s.status = 'started'; s.ticket = t.id
        toast(`已开工 · ${t.ref}`, { label: '打开', fn: () => go('ticket', t.id) })
        S.focusSel = '#main'
        render()
      }, 800)
    },
    'start-drop': el => { const s = startOf(el.dataset.id); s.status = 'dropped'; toast('这张开工卡不做了'); render() },

    'q-pick': el => { const t = ticket(el.dataset.id); const d = S.q[t.id]; d.answers[d.at] = t.questions.items[d.at].suggestions[+el.dataset.n].label; A['q-next'](el, true) },
    'q-next': (el, picked) => {
      const t = ticket(el.dataset.id); const d = S.q[t.id]
      const dk = `qa-${t.id}-${d.at}`
      const typed = (S.drafts[dk] || '').trim()
      if (typed && !picked) d.answers[d.at] = typed
      if (!d.answers[d.at]) { S.focusSel = `[data-draft="${dk}"]`; render(); return }
      const total = t.questions.items.length
      const missing = t.questions.items.findIndex((_, i) => !d.answers[i])
      if (missing >= 0) { d.at = missing; S.focusSel = `[data-qc="${t.id}"] .qc-opt, [data-qc="${t.id}"] input`; render(); return }
      if (d.at < total - 1) { d.at += 1; render(); return }
      const key = `q:${t.id}`
      S.busy.add(key); render()
      setTimeout(() => { S.busy.delete(key); finishAnswers(t, d.answers); S.focusSel = '#main'; render() }, 700)
    },
    'q-back': el => { const d = S.q[el.dataset.id]; d.at = Math.max(0, d.at - 1); S.focusSel = `[data-qc="${el.dataset.id}"] .qc-opt`; render() },

    reassign: el => openReassign(ticket(el.dataset.id), `[data-act="reassign"][data-id="${el.dataset.id}"]`),
    'reassign-ok': el => {
      const dlg = el.closest('dialog')
      const v = dlg.querySelector('input[name="reassign"]:checked')?.value
      const err = dlg.querySelector('[data-slot="reassign-err"]')
      if (!v) { err.textContent = '选一台机器和引擎。'; err.hidden = false; return }
      const [mid, eng] = v.split('|')
      const t = ticket(S.reassign.id)
      const time = clock()
      t.timeline.push({ kind: 'hub', time, who: '中枢', text: `改派到 ${mid} · ${EN[eng]}。` })
      Object.assign(t, { machine: mid, engine: eng, state: 'working', updated: time, ci: t.ci === 'failing' ? 'running' : t.ci })
      const mo = D.models.find(x => x.id === eng); t.model = mo.model; t.effort = mo.effort
      delete t.reason; delete t.repair
      closeDialog(dlg)
      returnSel = '#main'
      toast(`${t.ref} 已改派到 ${mid}`)
      render()
    },
    stop: el => {
      const t = ticket(el.dataset.id)
      confirmBox({ title: `停止 ${t.ref}？`, text: 'Worker 会结束这次会话。分支和 PR 保留，之后不能再继续这个工单。', ok: '停止', back: '#main', fn: () => {
        t.state = 'stopped'; t.updated = clock(); t.timeline.push({ kind: 'bad', time: clock(), who: '你', text: '停止了这个工单。' }); delete t.questions
        toast(`${t.ref} 已停止`); render()
      } })
    },
    steer: el => {
      const t = ticket(el.dataset.id), dk = `steer-${t.id}`
      const text = (S.drafts[dk] || '').trim()
      if (!text) { S.errors[`steer:${t.id}`] = '先写点什么。'; S.focusSel = `[data-draft="${dk}"]`; render(); return }
      delete S.errors[`steer:${t.id}`]
      t.timeline.push({ kind: 'me', time: clock(), who: '你', text })
      S.drafts[dk] = ''; S.focusSel = `[data-draft="${dk}"]`
      render()
      setTimeout(() => { t.timeline.push({ kind: 'worker', time: clock(), who: EN[t.engine], text: '收到，按这个方向调整。' }); render() }, 1600)
    },
    'panel-toggle': () => { S.panelOpen = !S.panelOpen; S.focusSel = '[data-act="panel-toggle"]'; render() },
    'tickets-tab': el => { S.ticketsTab = el.dataset.tab; render() },
    'search-clear': () => { S.drafts['ticket-search'] = ''; S.focusSel = '[data-draft="ticket-search"]'; render() },

    'plan-go': el => {
      const p = planOf(el.dataset.id), key = `plan:${p.id}`
      const m = D.machines.find(x => x.id === p.machine)
      delete S.errors[key]
      if (!m.engines.includes(p.engine)) { S.errors[key] = `${m.id} 上没有 ${EN[p.engine]}。`; render(); return }
      S.busy.add(key); render()
      setTimeout(() => {
        S.busy.delete(key)
        const t = newTicket({ title: p.title, repo: p.repo, machine: p.machine, engine: p.engine, model: D.models.find(x => x.id === p.engine).model, effort: D.models.find(x => x.id === p.engine).effort })
        p.status = 'confirmed'; p.ticket = t.id
        toast(`已开工 · ${t.ref}`, { label: '打开', fn: () => go('ticket', t.id) })
        render()
      }, 800)
    },
    'plan-ver': el => { S.planView[el.dataset.id] = +el.dataset.v; render() },
    'plan-revise': el => { const pid = el.dataset.id; if (S.planRevise.has(pid)) S.planRevise.delete(pid); else { S.planRevise.add(pid); S.focusSel = `[data-draft="revise-${pid}"]` } delete S.errors['revise:' + pid]; render() },
    'plan-revise-send': el => {
      const p = planOf(el.dataset.id), dk = `revise-${p.id}`
      const text = (S.drafts[dk] || '').trim()
      if (!text) { S.errors['revise:' + p.id] = '写一句要改什么。'; S.focusSel = `[data-draft="${dk}"]`; render(); return }
      delete S.errors['revise:' + p.id]; S.planRevise.delete(p.id); S.drafts[dk] = ''
      p.revising = true; render()
      setTimeout(() => {
        p.revising = false; p.version += 1; p.versions.push({ v: p.version, at: clock() }); S.planView[p.id] = p.version
        p.decisions.push(`按你的意见：${text}`)
        toast(`计划已更新到 v${p.version}`); render()
      }, 2400)
    },
    'plan-drop': el => { const p = planOf(el.dataset.id); confirmBox({ title: '这个计划不做了？', text: '计划会留在记录里，之后可以再提。', ok: '不做了', back: '#main', fn: () => { p.status = 'dropped'; render() } }) },

    'pull-close': el => { const p = D.pulls.find(x => x.id === el.dataset.id); confirmBox({ title: `关闭 PR #${p.n}？`, text: `${p.repo} 上的这个 PR 会被关闭，分支保留。`, ok: '关闭 PR', back: '#main', fn: () => { p.done = true; toast(`PR #${p.n} 已关闭`); render() } }) },
    'pull-keep': el => { const p = D.pulls.find(x => x.id === el.dataset.id); p.done = true; toast(p.kind === 'waiting' ? `一周后再提醒 PR #${p.n}` : `保留 PR #${p.n}`); render() },
    'cand-go': el => {
      const c = D.candidates.find(x => x.id === el.dataset.id), key = `cand:${c.id}`
      const m = D.machines.find(x => x.id === c.machine)
      delete S.errors[key]
      if (!m.engines.includes(c.engine)) { S.errors[key] = `${m.id} 上没有 ${EN[c.engine]}。`; render(); return }
      S.busy.add(key); render()
      setTimeout(() => { S.busy.delete(key); const t = newTicket({ title: c.title, repo: 'novan-xu/super-agent', machine: c.machine, engine: c.engine, model: c.model, effort: c.effort }); c.done = true; toast(`已派出 · ${t.ref}`, { label: '打开', fn: () => go('ticket', t.id) }); render() }, 700)
    },
    'cand-drop': el => { D.candidates.find(x => x.id === el.dataset.id).done = true; toast('已忽略'); render() },

    'mem-tab': el => { S.memTab = el.dataset.tab; render() },
    'mem-new': () => { S.memTab = 'mem'; S.memEditor = { text: '' }; S.drafts['mem-edit'] = ''; S.focusSel = '#mem-edit'; render() },
    'mem-edit': el => { const m = D.memory.find(x => x.id === el.dataset.id); S.memEditor = { id: m.id, text: m.text }; S.drafts['mem-edit'] = m.text; S.focusSel = '#mem-edit'; render() },
    'mem-cancel': () => { const back = S.memEditor?.id ? `[data-mem="${S.memEditor.id}"] [data-act="mem-edit"]` : '[data-act="mem-new"]'; S.memEditor = null; delete S.drafts['mem-edit']; S.focusSel = back; render() },
    'mem-save': () => {
      const ed = S.memEditor; const text = (S.drafts['mem-edit'] ?? ed.text).trim()
      if (!text) { ed.error = '内容不能为空。'; S.focusSel = '#mem-edit'; render(); return }
      if (D.memory.some(m => m.id !== ed.id && m.state !== 'rejected' && m.text === text)) { ed.error = '已经有一条一模一样的记忆。'; S.focusSel = '#mem-edit'; render(); return }
      S.busy.add('mem'); render()
      setTimeout(() => {
        S.busy.delete('mem')
        if (ed.id) { D.memory.find(m => m.id === ed.id).text = text; toast('已保存') } else { D.memory.unshift({ id: id('mm'), kind: 'memory', state: 'confirmed', text, source: '手动', at: '今天' }); toast('已记住') }
        S.memEditor = null; delete S.drafts['mem-edit']; render()
      }, 500)
    },
    'mem-confirm': el => { const m = D.memory.find(x => x.id === el.dataset.id); m.state = 'confirmed'; (m.replaces || []).forEach(r => { const o = D.memory.find(x => x.id === r); if (o) o.state = 'rejected' }); toast('已确认'); render() },
    'mem-reject': el => {
      const m = D.memory.find(x => x.id === el.dataset.id)
      if (m.state === 'pending') { m.state = 'rejected'; toast('已丢弃'); render(); return }
      confirmBox({ title: '删除这条记忆？', text: `「${m.text}」之后不再进入对话和 Router 的上下文。`, ok: '删除', back: '#main', fn: () => { m.state = 'rejected'; toast('已删除'); render() } })
    },
    'sum-arch': () => { S.showArchived = !S.showArchived; render() },
    'sum-clear': () => { S.drafts['sum-search'] = ''; S.focusSel = '[data-draft="sum-search"]'; render() },

    'machine-os': el => { S.machineOs = el.dataset.os; S.machineCmd = null; render() },
    'machine-make': () => {
      const name = (S.drafts['machine-name'] || '').trim()
      delete S.errors['machine-name']
      if (!name) S.errors['machine-name'] = '给这台机器起个名字。'
      else if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(name)) S.errors['machine-name'] = '只能用小写字母、数字和连字符，2 到 31 个字符。'
      else if (D.machines.some(m => m.id === name)) S.errors['machine-name'] = `${name} 已经存在。重新添加会给它换新的令牌。`
      if (S.errors['machine-name']) { S.focusSel = '#mname'; render(); return }
      S.busy.add('machine'); render()
      setTimeout(() => {
        S.busy.delete('machine')
        const code = Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase()
        S.machineCmd = S.machineOs === 'Windows'
          ? `git clone https://github.com/novan-xu/super-agent; .\\super-agent\\deploy\\runner\\install.ps1 -Id ${name} -Code ${code}`
          : `git clone https://github.com/novan-xu/super-agent && ./super-agent/deploy/runner/install.sh --id ${name} --code ${code}`
        render()
      }, 600)
    },
    'machine-revoke': el => { const m = D.machines.find(x => x.id === el.dataset.id); confirmBox({ title: `撤销 ${m.id}？`, text: '它的令牌和 Access 服务令牌会被删除，正在运行的工单会排队等别的机器。', ok: '撤销', back: '#main', fn: () => { D.machines = D.machines.filter(x => x !== m); toast(`${m.id} 已撤销`); render() } }) },
    'model-save': el => {
      const m = D.models.find(x => x.id === el.dataset.id), k = `model:${m.id}`
      S.busy.add(k); render()
      setTimeout(() => { S.busy.delete(k); Object.assign(m, S.modelDrafts[m.id]); delete S.modelDrafts[m.id]; toast(`${m.name} 已保存，下一次调用生效`); render() }, 600)
    },
    'repo-toggle': el => { const r = D.repos.find(x => x.name === el.dataset.id); r[el.dataset.f] = !r[el.dataset.f]; S.focusSel = `[data-act="repo-toggle"][data-id="${r.name}"][data-f="${el.dataset.f}"]`; render() },
    'rule-toggle': el => { D.rules[el.dataset.f] = !D.rules[el.dataset.f]; S.focusSel = `[data-act="rule-toggle"][data-f="${el.dataset.f}"]`; render() },
    'rule-merge': el => { D.rules.mergeAll = el.dataset.v === '1'; render() },
    'notify-self': () => {
      const me = D.devices.find(d => d.self)
      if (me.on) { me.on = false; render(); return }
      S.busy.add('notify'); render()
      setTimeout(() => { S.busy.delete('notify'); me.on = true; me.last = '刚刚'; toast('这个浏览器已开启通知'); S.focusSel = '[data-act="notify-self"]'; render() }, 900)
    },
    'notify-group': el => { const d = D.devices.find(x => x.id === el.dataset.id); d.groups[el.dataset.f] = !d.groups[el.dataset.f]; S.focusSel = `[data-act="notify-group"][data-f="${el.dataset.f}"]`; render() },
    'notify-test': el => toast(`已向 ${D.devices.find(d => d.id === el.dataset.id).name} 发送测试通知`),
    'device-revoke': el => { const d = D.devices.find(x => x.id === el.dataset.id); confirmBox({ title: `撤销 ${d.name}？`, text: '它不会再收到通知。', ok: '撤销', back: '#main', fn: () => { D.devices = D.devices.filter(x => x !== d); render() } }) },
    'conn-revoke': el => { const list = D.connections[el.dataset.kind]; const x = list.find(i => i.id === el.dataset.id); confirmBox({ title: `撤销 ${x.name}？`, text: '它的令牌立即失效，需要重新授权才能再连接。', ok: '撤销', back: '#main', fn: () => { D.connections[el.dataset.kind] = list.filter(i => i !== x); toast(`${x.name} 已撤销`); render() } }) },
    pair: () => { const c = Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase(); S.pairing = `${c}@agent.<domain>`; render() },
    copy: el => { const t = el.dataset.text; (navigator.clipboard?.writeText(t) || Promise.reject()).then(() => toast('已复制'), () => toast('浏览器不让复制，请手动选中', { bad: true })) },
    accent: el => { S.accent = el.dataset.v; try { localStorage.setItem('sa-accent', S.accent) } catch {  } S.focusSel = `[data-act="accent"][data-v="${S.accent}"]`; render() },
    theme: el => { S.theme = el.dataset.v; try { localStorage.setItem('sa-theme', S.theme) } catch {  } S.focusSel = `[data-act="theme"][data-v="${S.theme}"]`; render() },
    'key-rec': el => { const k = el.dataset.id; S.recording = S.recording === k ? null : k; delete S.keyNote[k]; S.focusSel = `[data-act="key-rec"][data-id="${k}"]`; render() },
    'key-clear': el => { D.shortcuts[el.dataset.id] = null; S.keyNote[el.dataset.id] = '已清除'; render() },
    'files-sort': el => { S.filesSort = el.dataset.v; render() },
  }

  const CHANGE = {
    'start-field': el => {
      const s = startOf(el.dataset.id), f = el.dataset.f
      s[f] = el.value
      if (f === 'engine') { const mo = D.models.find(x => x.id === s.engine); s.model = mo.model; s.effort = mo.effort }
      delete S.errors[`start:${s.id}`]
      S.focusSel = `#${el.id}`; render()
    },
    'cand-field': el => { const c = D.candidates.find(x => x.id === el.dataset.id); c[el.dataset.f] = el.value; if (el.dataset.f === 'engine') { const mo = D.models.find(x => x.id === c.engine); c.model = mo.model; c.effort = mo.effort } delete S.errors[`cand:${c.id}`]; S.focusSel = `#${el.id}`; render() },
    'plan-field': el => { const p = planOf(el.dataset.id); p[el.dataset.f] = el.value; delete S.errors[`plan:${p.id}`]; S.focusSel = `#${el.id}`; render() },
    'model-field': el => { const d = S.modelDrafts[el.dataset.id] ||= {}; d[el.dataset.f] = el.value; S.focusSel = `[data-change="model-field"][data-id="${el.dataset.id}"][data-f="${el.dataset.f}"]`; render() },
    'rule-time': el => { D.rules[el.dataset.f] = el.value },
    'accent-custom': el => { S.accent = el.value; try { localStorage.setItem('sa-accent', S.accent) } catch {  } S.focusSel = '[data-change="accent-custom"]'; render() },
    'att-add': el => { S.att[S.dest].push(...Array.from(el.files || []).map(f => f.name)); render() },
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]')
    if (!el || el.disabled) return
    if (el.matches('input[type="checkbox"]')) return
    const fn = A[el.dataset.act]
    if (fn) { e.preventDefault(); fn(el) }
  })
  document.addEventListener('change', e => {
    const el = e.target
    if (el.matches('input[type="checkbox"][data-act]')) { A[el.dataset.act]?.(el); return }
    const fn = CHANGE[el.dataset.change]
    if (fn) fn(el)
  })
  document.addEventListener('input', e => {
    const el = e.target
    if (el.dataset.draft !== undefined) {
      S.drafts[el.dataset.draft] = el.value
      if (S.memEditor && el.dataset.draft === 'mem-edit' && S.memEditor.error) { S.memEditor.error = null; el.removeAttribute('aria-invalid'); $('#mem-err')?.remove() }
    }
    if (el.hasAttribute('data-accent-live')) { S.accent = el.value; applyAccent() }
    if (el.matches('textarea[data-grow]')) grow(el)
    if (el.dataset.live) render()
  })
  document.addEventListener('keydown', e => {
    if (S.recording) {
      e.preventDefault()
      const k = S.recording
      if (e.key === 'Escape') { S.recording = null; render(); return }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return
      const mods = [e.ctrlKey && 'Ctrl', e.metaKey && '⌘', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean)
      if (!mods.length) { S.keyNote[k] = '需要至少一个修饰键，比如 Ctrl 或 Alt。'; render(); return }
      const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key
      const combo = [...mods, key]
      const other = k === 'tray' ? 'main' : 'tray'
      if (combo.join('+') === 'Ctrl+Shift+Escape' || (D.shortcuts[other] || []).join('+') === combo.join('+')) { S.keyNote[k] = '已被占用，之前的快捷键保留。'; S.recording = null; render(); return }
      D.shortcuts[k] = combo; S.keyNote[k] = '已保存'; S.recording = null
      S.focusSel = `[data-act="key-rec"][data-id="${k}"]`; render()
      return
    }
    const el = e.target
    if (e.key === 'Enter' && el.dataset?.enter && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      A[el.dataset.enter]?.(el)
    }
  })
  window.addEventListener('hashchange', () => { const r = parseHash(); if (r.view !== S.route.view || r.param !== S.route.param) { S.prev = S.route; S.route = r; render({ top: true }) } })

  S.route = parseHash()
  $('[data-slot="brand"]').innerHTML = `${logo(24)}<span>Super-agent</span>`
  render({ top: true })
})()
