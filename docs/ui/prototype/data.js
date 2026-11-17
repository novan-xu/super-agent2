window.SA_DATA = {
  hub: { online: true, brain: { online: true, model: 'gpt-6-astra', effort: 'high' }, router: 'Codex gpt-6-luna' },

  engines: { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity', deepseek: 'DeepSeek' },

  machines: [
    { id: 'pc', os: 'Windows', connected: true, labels: ['windows', 'rhino', 'company', 'personal'], engines: ['codex', 'claude', 'antigravity'], slots: 10, running: 2, idle: 1, seen: '在线' },
    { id: 'mac-mini', os: 'macOS', connected: true, labels: ['macos', 'personal'], engines: ['codex', 'claude', 'deepseek'], slots: 10, running: 1, idle: 1, seen: '在线' },
    { id: 'company-laptop', os: 'Windows', connected: false, labels: ['windows', 'company'], engines: ['claude'], slots: 4, running: 0, idle: 0, seen: '昨天 18:42 断开' },
  ],

  models: [
    { id: 'codex', name: 'Codex Worker', model: 'gpt-6.1-sol', effort: 'high', models: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'], efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'claude', name: 'Claude Worker', model: 'claude-opus-5-5', effort: 'xhigh', models: ['claude-opus-5-5', 'claude-sonnet-5-5'], efforts: ['medium', 'high', 'xhigh'] },
    { id: 'antigravity', name: 'Antigravity', model: '默认', effort: '默认', models: ['默认'], efforts: ['默认'] },
    { id: 'deepseek', name: 'DeepSeek Worker', model: 'deepseek-v4-pro', effort: '默认', models: ['deepseek-v4-pro', 'deepseek-flash'], efforts: ['默认'] },
    { id: 'brain', name: '大脑', model: 'gpt-6-astra', effort: 'high', models: ['gpt-6-astra', 'gpt-6.1-sol'], efforts: ['medium', 'high', 'xhigh'] },
    { id: 'router', name: 'Router', model: 'gpt-6-luna', effort: 'high', models: ['gpt-6-luna', 'gpt-6-astra'], efforts: ['low', 'medium', 'high'] },
  ],

  repos: [
    { name: 'novan-xu/super-agent', work: '个人', watch: true, review: true, merge: false },
    { name: 'novan-xu/NAS-management', work: '个人', watch: true, review: true, merge: true },
    { name: 'nuofan-island/notes', work: '公司', watch: true, review: false, merge: false },
    { name: 'nuofan-island/rhino-export', work: '公司', watch: false, review: true, merge: false },
  ],

  tickets: [
    {
      id: 't1', ref: 'tkt_7f3a21c0', title: 'iOS 上的 Web Push 收不到通知', repo: 'novan-xu/super-agent', state: 'question',
      machine: 'mac-mini', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', branch: 'agent/tkt_7f3a21c0', pr: 340, ci: 'passing',
      review: { state: '已通过', note: '#335 描述完整，无需修订' }, updated: '10:52', day: '今天',
      questions: { set: 'q1', items: [
        { text: 'iOS 只在主屏幕安装的网页里收推送。设置 → 通知 要不要在 iPhone Safari 里提示先「添加到主屏幕」？', suggestions: [
          { label: '提示，并附上操作步骤', detail: '只在 iOS Safari 且未安装时显示' }, { label: '不提示，写进 deploy.md' } ] },
        { text: 'VAPID 订阅在 iOS 上 30 天后会失效。失效时怎么处理？', suggestions: [
          { label: '下次打开页面时静默重新订阅', detail: '不再询问权限，权限仍在时有效' }, { label: '在待办里提醒我重新开启' } ] },
      ] },
      timeline: [
        { kind: 'start', time: '09:41', who: '中枢', text: '开工：在 mac-mini 上用 Codex 处理 #335。' },
        { kind: 'review', time: '09:42', who: '审阅者', text: '预审通过：#335 描述完整。' },
        { kind: 'hub', time: '09:43', who: '中枢', text: '已开 PR #340（草稿），分支 agent/tkt_7f3a21c0。' },
        { kind: 'worker', time: '09:58', who: 'Codex', text: 'iPhone 上的订阅请求返回 201，但 Safari 从未收到推送。查到原因：页面不是从主屏幕打开的，iOS 只给已安装的网页应用投递 Web Push。' },
        { kind: 'worker', time: '10:31', who: 'Codex', text: '已在 sw.js 里补上 iOS 需要的 notificationclick 处理，并让 manifest 的 display 改为 standalone。测试通过。' },
        { kind: 'ask', time: '10:52', who: 'Codex', text: '有两个问题需要你决定：\n1. 是否在 iPhone Safari 里提示「添加到主屏幕」\n2. 订阅过期后怎么处理' },
      ],
    },
    {
      id: 't2', ref: 'tkt_41be9d02', title: 'NAS 备份脚本迁移到 restic', repo: 'novan-xu/NAS-management', state: 'blocked',
      machine: 'pc', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', branch: 'agent/tkt_41be9d02', pr: 58, ci: 'failing',
      review: { state: '已通过', note: '' }, updated: '03:14', day: '今天',
      reason: 'Windows runner 上找不到 restic，CI 连续两次失败（pipeline #812、#815）。需要在 pc 上安装 restic，或者把这个工单改派到 mac-mini。',
      repair: { state: '只观察', host: 'pc', engine: 'Codex', note: 'CI 的谱系还没核实，暂不重跑。' },
      timeline: [
        { kind: 'start', time: '昨天 22:10', who: '中枢', text: '开工：在 pc 上用 Codex 处理 #57。' },
        { kind: 'worker', time: '昨天 23:02', who: 'Codex', text: '备份脚本已改用 restic，保留 7 个日备份、4 个周备份。' },
        { kind: 'bad', time: '02:40', who: 'CI', text: 'pipeline #812 失败：restic: command not found' },
        { kind: 'worker', time: '03:12', who: 'Codex', text: '重试后 #815 也失败了。pc 上没有安装 restic，这一步我没有权限装。' },
        { kind: 'bad', time: '03:14', who: '中枢', text: '受阻：需要你决定装 restic 还是改派。' },
      ],
    },
    {
      id: 't3', ref: 'tkt_c29e8a17', title: '工单详情的时间线按 Assignment 分组', repo: 'novan-xu/super-agent', state: 'working',
      machine: 'pc', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', branch: 'agent/tkt_c29e8a17', pr: 341, ci: 'running',
      review: { state: '已修订', note: '补全了 #336 的验收条件' }, updated: '11:20', day: '今天',
      timeline: [
        { kind: 'start', time: '11:02', who: '中枢', text: '开工：在 pc 上用 Codex 处理 #336。' },
        { kind: 'review', time: '11:03', who: '审阅者', text: '预审时修订了 #336：补全了验收条件。' },
        { kind: 'worker', time: '11:14', who: 'Codex', text: '先读了 views.ts 里 timelineItems 的现有排序，改派后的消息要保持在原来的位置。' },
        { kind: 'worker', time: '11:20', who: 'Codex', text: '分组逻辑写好了，正在补测试。' },
      ],
    },
    {
      id: 't4', ref: 'tkt_0d5f6b33', title: 'Rhino 导出插件支持 DWG 2018', repo: 'nuofan-island/rhino-export', state: 'working',
      machine: 'pc', engine: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', branch: 'agent/tkt_0d5f6b33', pr: 12, ci: 'passing',
      review: { state: '已通过', note: '' }, updated: '10:05', day: '今天',
      timeline: [
        { kind: 'start', time: '08:30', who: '中枢', text: '开工：在 pc 上用 Claude（公司账号）处理 #11。' },
        { kind: 'worker', time: '10:05', who: 'Claude', text: '导出版本选项已加上，正在用三个样例模型对照 Rhino 8 的原生导出。' },
      ],
    },
    {
      id: 't5', ref: 'tkt_93a1e4f8', title: 'README 部署章节翻译成中文', repo: 'nuofan-island/notes', state: 'queued',
      machine: 'pc', engine: 'antigravity', model: '默认', effort: '默认', branch: '', pr: null, ci: 'none',
      review: { state: '等待中', note: '' }, updated: '11:31', day: '今天', waitNote: '等 pc 上的 Antigravity 空出来',
      timeline: [ { kind: 'start', time: '11:31', who: '中枢', text: '排队：纯文字工作，等 pc 上的 Antigravity。' } ],
    },
    {
      id: 't6', ref: 'tkt_5b77c0de', title: 'Lark 长连接断线后自动重连', repo: 'novan-xu/super-agent', state: 'merged',
      machine: 'mac-mini', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', branch: 'agent/tkt_5b77c0de', pr: 329, ci: 'passing',
      review: { state: '已通过', note: '' }, updated: '01:48', day: '今天',
      timeline: [
        { kind: 'start', time: '昨天 21:15', who: '中枢', text: '开工：在 mac-mini 上用 Codex 处理 #326。' },
        { kind: 'worker', time: '昨天 23:40', who: 'Codex', text: '重连加了指数退避，上限 60 秒，断线期间的事件会在重连后补拉。' },
        { kind: 'ok', time: '01:48', who: '中枢', text: 'PR #329 已合并，工单完成。' },
      ],
    },
    { id: 't7', ref: 'tkt_2a90c4d1', title: '在 Windows 上验证记忆编辑', repo: 'novan-xu/super-agent', state: 'completed', machine: 'pc', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', branch: 'agent/tkt_2a90c4d1', pr: 261, ci: 'passing', review: { state: '已通过', note: '' }, updated: '11-10', day: '11-10', timeline: [] },
    { id: 't8', ref: 'tkt_e81f0377', title: '移除 Microsoft Teams 集成', repo: 'novan-xu/super-agent', state: 'merged', machine: 'mac-mini', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', branch: 'agent/tkt_e81f0377', pr: 266, ci: 'passing', review: { state: '已通过', note: '' }, updated: '11-09', day: '11-09', timeline: [] },
    { id: 't9', ref: 'tkt_6c3d9e20', title: '试验：Router 改回 DeepSeek 优先', repo: 'novan-xu/super-agent', state: 'stopped', machine: 'mac-mini', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', branch: 'agent/tkt_6c3d9e20', pr: null, ci: 'none', review: { state: '已通过', note: '' }, updated: '11-08', day: '11-08', timeline: [] },
  ],

  starts: [
    {
      id: 's1', kind: 'digest', title: '今早的 issue 摘要', repo: 'novan-xu/super-agent', time: '08:03',
      summary: '夜里新开了 3 个 issue，都能直接开工。去掉你不想做的，其余合成一个工单、一个 PR。',
      items: [
        { n: 337, title: '托盘弹窗在多显示器上出现在错误的屏幕', label: 'macos' },
        { n: 338, title: '记忆页的搜索不支持拼音首字母', label: '' },
        { n: 339, title: '设置 → 模型 保存后生效值不刷新', label: '' },
      ],
      machine: '自动', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high',
    },
    {
      id: 's2', kind: 'single', title: '给 NAS 加磁盘健康周报', repo: 'novan-xu/NAS-management', time: '11:40',
      summary: '每周日早上读一次 SMART 数据，有异常的盘写进周报，发到 chat。平台不限。',
      items: [], machine: '自动', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high',
    },
  ],

  plans: [
    {
      id: 'p1', title: '照片归档服务 photo-shelf', status: 'pending', version: 2, revising: false,
      versions: [ { v: 1, at: '10:17' }, { v: 2, at: '10:26' } ],
      work: '个人', platform: '不限', repo: 'novan-xu/photo-shelf', isNew: true, machine: 'mac-mini', engine: 'codex',
      goal: '在 NAS 上运行一个小服务，把手机同步上来的照片按拍摄日期归档到「年/月」目录，并去掉重复的照片。',
      first: { scope: '读取 EXIF 拍摄时间，没有 EXIF 的用文件修改时间；按内容哈希去重；先做命令行版本，在一个测试目录上跑通。', acceptance: '在 200 张样例照片上运行两次，第二次不移动任何文件；重复照片进入 duplicates/ 而不是被删除。' },
      backlog: ['Docker 镜像和 Compose 配置', '每晚定时运行', '一个只读的网页，按月份浏览'],
      decisions: ['从不删除原文件，只移动或标记', '归档目录结构为 YYYY/MM'],
      open: ['HEIC 是否需要转成 JPEG（建议先不转）'],
    },
  ],

  pulls: [
    { id: 'pr1', kind: 'leftover', repo: 'novan-xu/super-agent', n: 318, title: 'cbaab2a 之前的旧版工单详情改动', ticket: 'tkt_9e0b5c12', source: '#311 已在别处关闭', time: '昨天' },
    { id: 'pr2', kind: 'waiting', repo: 'nuofan-island/notes', n: 42, title: '会议纪要模板改成双语', ticket: 'tkt_77d1a0e4', days: 4, time: '11-08' },
  ],

  candidates: [
    { id: 'c1', title: '/agent 重跑一下不稳定的测试', text: '在 novan-xu/super-agent#305 的评论里：「/agent 把 live.test.ts 里那个偶尔超时的用例重跑十次看看」', source: 'GitHub', time: '09:12', why: 'Router 30 秒没有答复' },
  ],

  stream: {
    code: [
      { id: 'a1', type: 'day', text: '今天' },
      { id: 'a2', type: 'brain', time: '08:02', text: '早上好。夜里 tkt_5b77c0de 已合并；tkt_41be9d02 受阻，pc 上缺 restic，详情在待办。' },
      { id: 'a3', type: 'start', ref: 's1', time: '08:03' },
      { id: 'a4', type: 'me', time: '09:40', text: 'iPhone 上一直收不到推送，查一下' },
      { id: 'a5', type: 'brain', time: '09:41', text: '这属于 super-agent 仓库的工作，issue #335 已记下。按规则放在 mac-mini 上用 Codex，我已经直接开工。' },
      { id: 'a6', type: 'ticket', ref: 't1', time: '09:41' },
      { id: 'a7', type: 'me', time: '10:15', text: '我想做一个照片归档的小服务，放在 NAS 上，按拍摄日期整理' },
      { id: 'a8', type: 'brain', time: '10:16', text: '可以。会是一个新仓库 novan-xu/photo-shelf。我把第一步收窄到命令行版本，先在测试目录上跑通，Docker 和定时任务放进后续。计划在下面，确认后开工。' },
      { id: 'a9', type: 'plan', ref: 'p1', time: '10:26' },
      { id: 'a10', type: 'ticket', ref: 't3', time: '11:02' },
      { id: 'a11', type: 'start', ref: 's2', time: '11:40' },
    ],
    chat: [
      { id: 'b1', type: 'day', text: '今天' },
      { id: 'b2', type: 'brain', time: '07:30', text: '今天的邮件里有 2 封需要你回复：报价单确认、NAS 保修。其余都是通知。' },
      { id: 'b3', type: 'me', time: '08:15', text: '提醒我周五下午三点给物业打电话' },
      { id: 'b4', type: 'brain', time: '08:15', text: '已加到 TickTick 收件箱：周五 15:00 给物业打电话。' },
      { id: 'b5', type: 'me', time: '09:05', text: '记住：周报用中文写，标题带日期' },
      { id: 'b6', type: 'sys', time: '09:05', text: '已记住：周报用中文写，标题带日期' },
      { id: 'b7', type: 'sys', time: '09:41', text: '一条仓库相关的消息已转到 code', link: 'code' },
    ],
  },

  memory: [
    { id: 'm1', kind: 'memory', state: 'pending', text: 'Rhino 相关的工作默认放在 pc 上运行', source: 'tkt_0d5f6b33', at: '今天' },
    { id: 'm2', kind: 'memory', state: 'pending', text: 'super-agent 的 PR 必须等 CI 全绿才能合并', source: 'tkt_5b77c0de', at: '今天', replaces: ['m6'] },
    { id: 'm3', kind: 'memory', state: 'confirmed', text: '和我对话一律用简体中文；代码、提交和 issue 用英文', source: '手动', at: '11-02' },
    { id: 'm4', kind: 'memory', state: 'confirmed', text: '个人仓库在 Windows 上的工作用 Codex', source: 'tkt_31c7a990', at: '11-06' },
    { id: 'm5', kind: 'memory', state: 'confirmed', text: '周报用中文写，标题带日期', source: '对话', at: '今天' },
    { id: 'm6', kind: 'memory', state: 'confirmed', text: 'super-agent 的 PR 在 CI 失败时可以手动合并', source: 'tkt_4410be02', at: '11-04' },
    { id: 'm7', kind: 'identity', state: 'confirmed', text: 'novan-xu 是我的个人 GitHub 账号', source: '手动', at: '11-01' },
    { id: 'm8', kind: 'identity', state: 'confirmed', text: 'nuofan-island 是公司的 GitHub 组织', source: '手动', at: '11-01' },
    { id: 'm9', kind: 'mail_preference', state: 'confirmed', text: 'GitHub 的通知邮件不进邮件摘要', source: '对话', at: '11-07' },
  ],

  summaries: [
    { id: 'u1', range: '今天 08:00 – 10:30', title: 'iOS 推送排查与照片归档计划', text: '查明 iOS 只给主屏幕安装的网页应用投递 Web Push，开工 tkt_7f3a21c0。讨论 photo-shelf 的范围：第一步只做命令行，从不删除原文件。' },
    { id: 'u2', range: '昨天 19:00 – 23:10', title: 'NAS 备份迁移', text: '决定把备份从 rsync 换成 restic，保留 7 个日备份、4 个周备份。开工 tkt_41be9d02。' },
    { id: 'u3', range: '11-10', title: '设置页分组', text: '讨论设置页的 9 个分区太散，倾向按执行、规则、连接、个人分组。' },
    { id: 'u4', range: '11-08', title: 'Router 顺序', text: '试验 DeepSeek 优先后改回 Codex 优先，原因是 ChatGPT 套餐不按量计费。', archived: true },
  ],

  devices: [
    { id: 'd1', name: 'pc · 桌面版', kind: '桌面', on: true, groups: { need: true, done: true, personal: true }, last: '刚刚', self: false },
    { id: 'd2', name: 'mac-mini · 桌面版', kind: '桌面', on: true, groups: { need: true, done: true, personal: false }, last: '10 分钟前', self: false },
    { id: 'd3', name: 'iPhone · Safari', kind: '推送', on: true, groups: { need: true, done: false, personal: true }, last: '今天 08:15', self: false },
    { id: 'd4', name: '这个浏览器', kind: '网页', on: false, groups: { need: true, done: true, personal: true }, last: '—', self: true },
  ],

  connections: {
    lark: { state: '已连接', note: '只用于聊天' },
    github: [ { login: 'novan-xu', note: '个人' }, { login: 'nuofan-island', note: '公司' } ],
    reviewer: { state: '在线', note: 'claude -p · 只读' },
    clients: [ { id: 'o1', name: 'ChatGPT', kind: 'OAuth', since: '11-03' }, { id: 'o2', name: 'Claude（个人）', kind: 'OAuth', since: '11-05' } ],
    bridges: [ { id: 'b1', name: 'work-laptop · Claude Desktop', kind: '桥接令牌', since: '11-06' } ],
    desktops: [ { id: 'k1', name: 'pc', kind: '桌面设备', since: '11-07' }, { id: 'k2', name: 'mac-mini', kind: '桌面设备', since: '11-08' } ],
  },

  rules: { quiet: true, quietFrom: '23:00', quietTo: '07:30', digest: true, digestAt: '08:00', mergeAll: false, reviewIssues: true, watchCI: true },

  shortcuts: { tray: ['Ctrl', 'Alt', 'Space'], main: ['Ctrl', 'Alt', 'Enter'] },

  files: [
    { id: 'f1', name: 'ios-push-log.txt', size: 18432, at: '今天 09:40', where: 'code' },
    { id: 'f2', name: 'tray-multi-display.png', size: 421888, at: '今天 08:20', where: 'code' },
    { id: 'f3', name: 'restic-config.yaml', size: 2150, at: '昨天 22:05', where: 'code' },
    { id: 'f4', name: '照片目录结构.md', size: 6120, at: '今天 10:15', where: 'code' },
    { id: 'f5', name: '物业合同.pdf', size: 1288000, at: '11-09', where: 'chat' },
  ],
}
