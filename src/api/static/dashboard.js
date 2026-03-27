/* ============================================
   Symbiont Dashboard — 禅意水墨 × 现代仪表
   Vanilla JS, no framework
   ============================================ */

;(function () {
  'use strict'

  // ---- State ----
  let allCards = []
  let allTags = new Set()
  var cyInstance = null
  var confThreshold = 0
  var TAG_COLORS = ['#c53d43', '#2d6a4f', '#264653', '#e76f51', '#457b9d', '#6d597a', '#b56576', '#355070', '#e09f3e', '#386641']
  var tagColorMap = {}
  var eventSource = null
  var memoryTab = 'cards' // 'cards' | 'connections' | 'cognitions'
  var conversationDetailMode = 'simple' // 'simple' | 'detailed'
  var currentConversationSessionId = null
  var currentConversationData = null
  var currentConversationPanelId = null

  // ---- API Helper ----
  function getToken() {
    return localStorage.getItem('symbiont_dashboard_token') || ''
  }

  function promptToken() {
    window.location.href = '/login'
  }

  function authHeaders() {
    var token = getToken()
    var h = { 'Content-Type': 'application/json' }
    if (token) h['Authorization'] = 'Bearer ' + token
    return h
  }

  async function api(path, options) {
    try {
      var opts = options || {}
      if (opts.method && opts.method !== 'GET') {
        opts.headers = Object.assign(authHeaders(), opts.headers || {})
      }
      var r = await fetch(path, opts)
      if (r.status === 401) {
        promptToken()
        // 重试一次
        if (getToken()) {
          opts.headers = Object.assign(authHeaders(), opts.headers || {})
          r = await fetch(path, opts)
        }
      }
      return r.ok ? r.json() : null
    } catch {
      return null
    }
  }

  // ---- Time formatting ----
  function relativeTime(ts) {
    if (!ts) return ''
    const now = Date.now()
    const t = new Date(ts).getTime()
    const diff = Math.floor((now - t) / 1000)
    if (diff < 60) return '刚刚'
    if (diff < 3600) return Math.floor(diff / 60) + '分钟前'
    if (diff < 86400) return Math.floor(diff / 3600) + '小时前'
    if (diff < 604800) return Math.floor(diff / 86400) + '天前'
    return formatDate(ts)
  }

  function formatDate(ts) {
    if (!ts) return '-'
    var d = new Date(ts)
    var parts = d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-').split('-')
    var time = d.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
    return parts[1] + '-' + parts[2] + ' ' + time
  }

  function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    let parts = []
    if (d > 0) parts.push(d + '天')
    if (h > 0) parts.push(h + '时')
    parts.push(m + '分')
    return '运行 ' + parts.join(' ')
  }

  function truncate(s, n) {
    if (!s) return ''
    return s.length > n ? s.slice(0, n) + '…' : s
  }

  function debounce(fn, ms) {
    let t
    return function () {
      clearTimeout(t)
      t = setTimeout(fn, ms)
    }
  }

  // ---- Clock ----
  function updateClock() {
    const el = document.getElementById('clock')
    if (el) el.textContent = new Date().toLocaleString('zh-CN')
  }
  setInterval(updateClock, 1000)
  updateClock()

  // ---- Tab routing ----
  const VIEWS = ['overview', 'memory', 'graph', 'instances', 'cron', 'activity', 'tasks', 'wishes', 'issues', 'persona', 'mcp', 'skills', 'releases']

  function getHash() {
    const h = location.hash.slice(1)
    return VIEWS.includes(h) ? h : 'overview'
  }

  function switchView(name) {
    document.querySelectorAll('.nav-item').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('href') === '#' + name)
    })
    document.querySelectorAll('.view').forEach(function (v) {
      var isActive = v.id === 'view-' + name
      v.classList.toggle('active', isActive)
    })
    // Close mobile sidebar on navigation
    var sidebar = document.getElementById('sidebar')
    if (sidebar) sidebar.classList.remove('open')
    // Load data for view
    if (name === 'overview') loadOverview()
    if (name === 'memory') loadCards()
    if (name === 'graph') initGraph()
    if (name === 'instances') loadInstances()
    if (name === 'cron') loadCron()
    if (name === 'activity') loadActivity()
    if (name === 'tasks') loadTasks()
    if (name === 'wishes') loadWishes()
    if (name === 'issues') loadIssues()
    if (name === 'releases') loadReleases()
    if (name === 'persona') loadPersonas()
    if (name === 'mcp') loadMcpStatus()
    if (name === 'skills') loadSkills()
  }

  document.querySelectorAll('.nav-item').forEach(function (t) {
    t.addEventListener('click', function (e) {
      e.preventDefault()
      var name = t.getAttribute('href').slice(1)
      location.hash = name
      switchView(name)
    })
  })

  // Sidebar toggle for mobile
  var sidebarToggle = document.getElementById('sidebar-toggle')
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', function () {
      var sidebar = document.getElementById('sidebar')
      if (sidebar) sidebar.classList.toggle('open')
    })
  }

  var backdrop = document.getElementById('sidebar-backdrop')
  if (backdrop) {
    backdrop.addEventListener('click', function () {
      var sidebar = document.getElementById('sidebar')
      if (sidebar) sidebar.classList.remove('open')
    })
  }

  window.addEventListener('hashchange', function () {
    switchView(getHash())
  })

  // ============================================
  // SSE Connection
  // ============================================

  function connectSSE() {
    if (eventSource) { eventSource.close(); eventSource = null }

    // SSE 认证优先用 cookie（登录时已设置），token query param 作为 fallback
    // 不带 token 参数时，SSE manager 会检查 cookie
    var token = getToken()
    var url = '/api/sse'
    if (token) url += '?token=' + encodeURIComponent(token)
    eventSource = new EventSource(url, { withCredentials: true })

    eventSource.addEventListener('heartbeat', function (e) {
      var data = JSON.parse(e.data)
      if (getHash() === 'overview') renderOverview(data)
    })

    eventSource.addEventListener('instance', function (e) {
      if (getHash() === 'instances') loadInstances()
    })

    eventSource.addEventListener('conversation', function (e) {
      var data = JSON.parse(e.data)
      handleConversationSSE(data)
    })

    eventSource.addEventListener('activity', function (e) {
      if (getHash() === 'activity') loadActivity()
    })

    eventSource.addEventListener('task', function (e) {
      if (getHash() === 'tasks') loadTasks()
    })

    eventSource.addEventListener('issue', function (e) {
      if (getHash() === 'issues') loadIssues()
    })

    eventSource.addEventListener('cron', function (e) {
      if (getHash() === 'cron') loadCron()
    })

    eventSource.addEventListener('memory', function (e) {
      if (getHash() === 'memory') reloadCurrentMemoryView()
    })

    eventSource.addEventListener('graph', function (e) {
      if (getHash() === 'graph') handleGraphUpdate()
    })

    eventSource.addEventListener('release', function (e) {
      if (getHash() === 'releases') loadReleases()
    })

    eventSource.onerror = function () {
      // EventSource auto-reconnects, no action needed
    }
  }

  // ---- CC Message Block Rendering ----

  function renderMessageBlocks(blocks, mode) {
    if (!blocks || !Array.isArray(blocks)) return ''
    var html = ''
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i]
      if (b.type === 'text') {
        html += '<div class="msg-block msg-text">' + escHtml(b.text || '') + '</div>'
      } else if (b.type === 'tool_use') {
        if (mode === 'simple') {
          var summary = '\uD83D\uDD27 ' + (b.name || 'tool') + '(' + truncate(JSON.stringify(b.input || {}), 60) + ')'
          html += '<div class="msg-block msg-tool-summary" onclick="this.classList.toggle(\'expanded\')">'
          html += '<span class="tool-summary-text">' + escHtml(summary) + '</span>'
          html += '<pre class="tool-detail">' + escHtml(JSON.stringify(b.input, null, 2)) + '</pre>'
          html += '</div>'
        } else {
          html += '<div class="msg-block msg-tool-use">'
          html += '<div class="tool-name">' + escHtml(b.name || 'tool') + '</div>'
          html += '<pre>' + escHtml(JSON.stringify(b.input, null, 2)) + '</pre>'
          html += '</div>'
        }
      } else if (b.type === 'tool_result') {
        if (mode === 'detailed') {
          html += '<div class="msg-block msg-tool-result" onclick="this.classList.toggle(\'expanded\')">'
          html += '<span class="tool-result-label">Result</span>'
          html += '<pre class="tool-result-content">' + escHtml(truncate(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 500)) + '</pre>'
          html += '</div>'
        }
      } else if (b.type === 'thinking') {
        if (mode === 'detailed') {
          html += '<div class="msg-block msg-thinking" onclick="this.classList.toggle(\'expanded\')">'
          html += '<span class="thinking-label">Thinking</span>'
          html += '<div class="thinking-content">' + escHtml(b.thinking || b.text || '') + '</div>'
          html += '</div>'
        }
      }
    }
    return html
  }

  function renderConversationMessage(msg) {
    var blocks = msg.blocks || (msg.data && msg.data.blocks)
    if (blocks && blocks.length > 0) {
      return renderMessageBlocks(blocks, conversationDetailMode)
    }
    // Fallback: plain text (old data without blocks)
    return '<div class="msg-text">' + escHtml(msg.content || (msg.data && msg.data.content) || '') + '</div>'
  }

  function toggleConversationMode(checkbox) {
    conversationDetailMode = checkbox.checked ? 'detailed' : 'simple'
    if (currentConversationSessionId && currentConversationData) {
      renderConversationPanel(currentConversationData)
    }
  }

  function renderConversationPanel(msgs) {
    if (!currentConversationSessionId) return
    var convId = currentConversationPanelId
    var panel = convId ? document.getElementById(convId) : null
    if (!panel) return

    var h = '<div class="conversation-panel-header">'
    h += '<div class="conversation-panel-title">\u5BF9\u8BDD\u8BB0\u5F55 (' + msgs.length + ')</div>'
    h += '<label class="mode-switch"><input type="checkbox" onchange="((' + 'function(cb){var e=new CustomEvent(\'conv-mode-toggle\',{detail:cb.checked});document.dispatchEvent(e)})(this))"'
    h += (conversationDetailMode === 'detailed' ? ' checked' : '') + '><span>\u8BE6\u7EC6</span></label>'
    h += '</div>'
    h += '<div class="conversation-messages" id="conversation-messages">'
    msgs.forEach(function (m) {
      var role = m.role || '?'
      var roleLabel = role === 'user' ? '\u7528\u6237' : role === 'assistant' ? '\u52A9\u624B' : role
      var time = m.timestamp ? m.timestamp.slice(11, 19) : ''
      h += '<div class="conv-msg ' + escHtml(role) + '">'
      h += '<div class="conv-msg-role">' + escHtml(roleLabel) + '</div>'
      h += '<div class="conv-msg-bubble">' + renderConversationMessage(m) + '</div>'
      if (time) h += '<div class="conv-msg-time">' + escHtml(time) + '</div>'
      h += '</div>'
    })
    h += '</div>'
    panel.innerHTML = h
    requestAnimationFrame(function () { panel.scrollTop = panel.scrollHeight })
  }

  // Global event listener for mode toggle (needed because onclick inline can't access IIFE scope)
  document.addEventListener('conv-mode-toggle', function (e) {
    conversationDetailMode = e.detail ? 'detailed' : 'simple'
    if (currentConversationSessionId && currentConversationData) {
      renderConversationPanel(currentConversationData)
    }
  })

  function handleConversationSSE(data) {
    if (!currentConversationSessionId) return
    if (data.sessionId !== currentConversationSessionId) return

    var container = document.getElementById('conversation-messages')
    if (!container) return
    var msg = data.message || data
    var role = msg.role || 'assistant'
    var roleLabel = role === 'user' ? '\u7528\u6237' : role === 'assistant' ? '\u52A9\u624B' : role
    var div = document.createElement('div')
    div.className = 'conv-msg ' + role
    var innerHtml = '<div class="conv-msg-role">' + escHtml(roleLabel) + '</div>'
    innerHtml += '<div class="conv-msg-bubble">' + renderConversationMessage(msg) + '</div>'
    div.innerHTML = innerHtml
    container.appendChild(div)
    container.scrollTop = container.scrollHeight
    // Also update cached data
    if (currentConversationData) {
      currentConversationData.push(msg)
    }
  }
  function reloadCurrentMemoryView() {
    if (memoryTab === 'cards') loadCards()
    else if (memoryTab === 'connections') loadConnections()
    else if (memoryTab === 'cognitions') loadCognitions()
  }
  function handleGraphUpdate() { initGraph() }

  // ============================================
  // Overview
  // ============================================

  async function loadOverview() {
    var data = await api('/api/overview')
    if (!data) {
      document.getElementById('overview-content').innerHTML =
        '<p class="ink-faint">无法连接到 Symbiont</p>'
      return
    }
    renderOverview(data)
  }

  function renderOverview(data) {
    var uptime = data.uptime || 0
    var rss = data.rss || 0
    var persona = data.persona || '-'
    var cron = data.cron || {}
    var mem = data.memoryStats || {}

    // instances: API returns { instances: number, instancesActive: number }
    var totalInst = data.instances || 0
    var activeInst = data.instancesActive || 0

    // cron: { running: bool, jobs: number }
    var cronRunning = cron.running
    var cronJobs = typeof cron.jobs === 'number' ? cron.jobs : (Array.isArray(cron.jobs) ? cron.jobs.length : 0)

    // settler: string directly
    var settlerStatus = (typeof data.settler === 'string') ? data.settler : (data.settler?.status || 'idle')

    // embedding: boolean directly
    var embAvail = (typeof data.embedding === 'boolean') ? data.embedding : data.embedding?.available

    var totalCards = mem.total || 0
    var activeCards = mem.active || 0
    var archivedCards = mem.archived || 0

    // Settler status dot class
    var settlerDot = settlerStatus === 'idle' ? 'idle' :
      settlerStatus === 'in_progress' ? 'warning' :
      settlerStatus === 'done' ? 'healthy' : 'idle'

    var html = ''

    // Hero: uptime
    html += '<div class="overview-hero">'
    html += '<div class="big-number">' + escHtml(formatUptime(uptime)) + '</div>'
    html += '<div class="big-label">' + escHtml(persona) + '</div>'
    html += '</div>'

    // Row: key metrics
    html += '<div class="overview-row">'
    html += metricBlock(rss + ' MB', '进程内存')
    html += metricBlock(totalCards, '记忆总量')
    html += metricBlock(activeCards, '活跃记忆')
    html += metricBlock(archivedCards, '已归档')
    html += '</div>'

    // Row: instances
    html += '<div class="overview-row">'
    html += metricBlock(activeInst + ' / ' + totalInst, 'CC 实例')
    html += metricBlock(cronJobs, '定时任务')
    html += '</div>'

    // Status group
    html += '<div class="overview-status-group">'
    html += '<h3>服务状态</h3>'
    html += '<div class="status-items">'

    html += statusItem(cronRunning ? 'healthy' : 'idle', '定时调度', cronRunning ? '运行中' : '已停止')
    html += statusItem(embAvail ? 'healthy' : 'error', '向量服务', embAvail ? '可用' : '不可用')
    html += statusItem(settlerDot, 'Settler', settlerStatus)

    html += '</div>'

    // Memory bar
    if (totalCards > 0) {
      var activePct = (activeCards / totalCards * 100).toFixed(1)
      var archPct = (archivedCards / totalCards * 100).toFixed(1)
      html += '<div class="memory-bar">'
      html += '<div class="memory-bar-segment" style="width:' + activePct + '%;background:var(--jade)"></div>'
      html += '<div class="memory-bar-segment" style="width:' + archPct + '%;background:var(--ink-faint)"></div>'
      html += '</div>'
    }

    html += '</div>'

    document.getElementById('overview-content').innerHTML = html
  }

  function metricBlock(value, label) {
    return '<div class="overview-metric">' +
      '<div class="metric-value">' + escHtml(String(value)) + '</div>' +
      '<div class="metric-label">' + escHtml(label) + '</div>' +
      '</div>'
  }

  function statusItem(dotClass, name, detail) {
    return '<div class="status-item">' +
      '<span class="status-dot ' + dotClass + '"></span>' +
      '<span>' + escHtml(name) + '</span>' +
      '<span class="ink-faint" style="margin-left:4px">' + escHtml(detail) + '</span>' +
      '</div>'
  }

  // ============================================
  // Memory
  // ============================================

  function renderMemoryTabs() {
    return '<div class="memory-tabs">' +
      '<button class="mem-tab' + (memoryTab === 'cards' ? ' active' : '') + '" data-tab="cards">卡片</button>' +
      '<button class="mem-tab' + (memoryTab === 'connections' ? ' active' : '') + '" data-tab="connections">连接</button>' +
      '<button class="mem-tab' + (memoryTab === 'cognitions' ? ' active' : '') + '" data-tab="cognitions">认知</button>' +
      '</div>'
  }

  function switchMemoryTab(tab) {
    memoryTab = tab
    if (tab === 'cards') loadCards()
    else if (tab === 'connections') loadConnections()
    else if (tab === 'cognitions') loadCognitions()
  }

  document.addEventListener('click', function (e) {
    if (e.target.classList.contains('mem-tab')) {
      var tab = e.target.getAttribute('data-tab')
      if (tab) switchMemoryTab(tab)
    }
  })

  document.addEventListener('click', function (e) {
    if (e.target.classList.contains('conn-node')) {
      var cardId = e.target.getAttribute('data-card-id')
      if (cardId) showDetail(cardId)
    }
  })

  document.addEventListener('click', function (e) {
    if (e.target.classList.contains('source-card-link')) {
      e.preventDefault()
      var cardId = e.target.getAttribute('data-card-id')
      if (cardId) showDetail(cardId)
    }
  })

  async function loadConnections() {
    var list = document.getElementById('memory-list')
    list.innerHTML = '<p class="empty-state">加载中…</p>'
    var data = await api('/api/connections?limit=100')
    var html = renderMemoryTabs()
    html += '<div class="connections-list">'
    if (!data || data.length === 0) {
      html += '<p class="empty-state">暂无连接数据</p>'
    } else {
      data.forEach(function (c) {
        html += '<div class="connection-item">'
        html += '<span class="conn-node conn-from" data-card-id="' + escAttr(c.fromId || c.from_id || '') + '">' + escHtml(c.fromContent || c.from_content || c.fromId || '') + '</span>'
        html += ' <span class="conn-arrow">—(' + escHtml(c.type || '?') + '/' + (c.strength || 0).toFixed(1) + ')→</span> '
        html += '<span class="conn-node conn-to" data-card-id="' + escAttr(c.toId || c.to_id || '') + '">' + escHtml(c.toContent || c.to_content || c.toId || '') + '</span>'
        html += '</div>'
      })
    }
    html += '</div>'
    list.innerHTML = html
  }

  async function loadCognitions() {
    var list = document.getElementById('memory-list')
    list.innerHTML = '<p class="empty-state">加载中…</p>'
    var data = await api('/api/cognitions')
    var html = renderMemoryTabs()
    html += '<div class="cognitions-list">'
    if (!data || data.length === 0) {
      html += '<p class="empty-state">暂无认知数据</p>'
    } else {
      var groups = {}
      data.forEach(function (c) {
        var tag = c.tag || 'uncategorized'
        if (!groups[tag]) groups[tag] = []
        groups[tag].push(c)
      })
      for (var tag in groups) {
        html += '<div class="cognition-group">'
        html += '<h4>' + escHtml(tag) + '</h4>'
        groups[tag].forEach(function (c) {
          var statusClass = c.status === 'confirmed' ? 'status-confirmed' : c.status === 'rejected' ? 'status-rejected' : 'status-pending'
          html += '<div class="cognition-item">'
          html += '<span class="cognition-status ' + statusClass + '">' + escHtml(c.status || 'pending') + '</span>'
          html += '<p>' + escHtml(c.summary || '') + '</p>'
          var cards = c.source_cards || c.sourceCards
          if (cards) {
            if (typeof cards === 'string') { try { cards = JSON.parse(cards) } catch (err) { cards = [] } }
            if (cards && cards.length > 0) {
              html += '<details><summary>源卡片 (' + cards.length + ')</summary><div class="source-cards">'
              cards.forEach(function (id) {
                html += '<a href="#" class="source-card-link" data-card-id="' + escAttr(id) + '">' + escHtml(String(id).slice(0, 12)) + '</a> '
              })
              html += '</div></details>'
            }
          }
          html += '</div>'
        })
        html += '</div>'
      }
    }
    html += '</div>'
    list.innerHTML = html
  }

  async function loadCards() {
    var params = new URLSearchParams()
    var q = document.getElementById('mem-search').value
    var tag = document.getElementById('mem-tag').value
    var st = document.getElementById('mem-status').value
    var owner = document.getElementById('mem-owner').value
    if (q) params.set('q', q)
    if (tag) params.set('tag', tag)
    if (st) params.set('status', st)
    if (owner) params.set('owner', owner)

    var data = await api('/api/cards?' + params)
    if (!data) {
      document.getElementById('memory-list').innerHTML =
        renderMemoryTabs() + '<p class="empty-state">无法加载记忆数据</p>'
      return
    }
    allCards = Array.isArray(data) ? data : (data.cards || [])
    renderCards()
    populateTags()
    populateOwners()
  }

  function renderCards() {
    var list = document.getElementById('memory-list')
    if (allCards.length === 0) {
      list.innerHTML = renderMemoryTabs() + '<p class="empty-state">暂无记忆</p>'
      return
    }
    list.innerHTML = renderMemoryTabs() + allCards.map(function (c) {
      var conf = c.confidence || 0
      var confPct = (conf * 100).toFixed(0)
      var confColor = conf >= 0.8 ? 'var(--ink)' : conf >= 0.4 ? 'var(--ink-light)' : 'var(--ink-faint)'
      var status = c.archived ? '归档' : '活跃'

      return '<div class="card-row" data-id="' + escAttr(c.id) + '">' +
        '<div>' +
        '<div class="card-content">' + escHtml(truncate(c.content, 80)) + '</div>' +
        '<div class="card-meta">' +
        (c.scene ? '<span class="card-scene">' + escHtml(c.scene) + '</span>' : '') +
        (c.tags || []).map(function (t) { return '<span class="card-tag">' + escHtml(t) + '</span>' }).join('') +
        '<span class="card-time">' + relativeTime(c.createdAt || c.created_at) + '</span>' +
        (c.owner ? '<span class="card-owner">' + escHtml(c.owner === 'xiaoxi' ? '小希' : c.owner === 'shared' ? '共享' : c.owner) + '</span>' : '') +
        '</div>' +
        '</div>' +
        '<div class="card-right">' +
        '<div class="card-confidence-text">' +
        '<span class="confidence-bar"><span class="confidence-fill" style="width:' + confPct + '%;background:' + confColor + '"></span></span> ' +
        confPct + '%' +
        '</div>' +
        '<div class="card-status-badge">' + status + '</div>' +
        '</div>' +
        '</div>'
    }).join('')

    // Click handlers
    list.querySelectorAll('.card-row').forEach(function (row) {
      row.addEventListener('click', function () {
        showDetail(row.getAttribute('data-id'))
      })
    })
  }

  function populateTags() {
    allCards.forEach(function (c) {
      (c.tags || []).forEach(function (t) { allTags.add(t) })
    })
    var sel = document.getElementById('mem-tag')
    var cur = sel.value
    sel.innerHTML = '<option value="">全部标签</option>' +
      Array.from(allTags).map(function (t) {
        return '<option value="' + escAttr(t) + '">' + escHtml(t) + '</option>'
      }).join('')
    sel.value = cur
  }

  var ownersPopulated = false
  function populateOwners() {
    if (ownersPopulated) return
    // 只在第一次（无 owner 筛选时）从全量卡片提取 owner 列表
    var ownerEl = document.getElementById('mem-owner')
    if (!ownerEl || ownerEl.options.length > 3) return
    var owners = new Set()
    allCards.forEach(function (c) { if (c.owner) owners.add(c.owner) })
    var cur = ownerEl.value
    var opts = '<option value="">全部归属</option>'
    Array.from(owners).sort().forEach(function (o) {
      var label = o === 'xiaoxi' ? '小希' : o === 'shared' ? '共享知识' : o
      opts += '<option value="' + escAttr(o) + '">' + escHtml(label) + '</option>'
    })
    ownerEl.innerHTML = opts
    ownerEl.value = cur
    ownersPopulated = true
  }

  async function showDetail(id) {
    var data = await api('/api/cards/' + id)
    if (!data) return
    var c = data.card || data
    var conns = data.connections || c.connections || []
    var conf = c.confidence || 0

    var panel = document.getElementById('memory-detail')
    var html = '<button class="detail-close" id="detail-close-btn">&times;</button>'
    html += '<h3 class="detail-title">' + escHtml(truncate(c.content, 100)) + '</h3>'
    html += '<div class="detail-meta">置信度 ' + (conf * 100).toFixed(0) + '% &middot; '
    html += (c.archived ? '已归档' : '活跃') + ' &middot; '
    html += '场景: ' + escHtml(c.scene || '-') + '</div>'
    html += '<div class="detail-body">' + escHtml(c.content || '') + '</div>'

    if (c.tags && c.tags.length) {
      html += '<div class="card-meta" style="margin-bottom:12px">'
      html += c.tags.map(function (t) { return '<span class="card-tag">' + escHtml(t) + '</span>' }).join('')
      html += '</div>'
    }

    if (conns.length) {
      html += '<div class="detail-connections">'
      html += '<h4>关联记忆</h4>'
      html += conns.map(function (cn) {
        return '<div class="conn-item">' +
          '<span>' + escHtml(truncate(cn.content || cn.toId || cn.from_id || '', 60)) + '</span>' +
          '<span class="conn-type">' + escHtml(cn.type || 'link') +
          (cn.strength ? ' ' + cn.strength.toFixed(1) : '') + '</span></div>'
      }).join('')
      html += '</div>'
    }

    // Edit form (hidden by default)
    html += '<div class="detail-edit" id="detail-edit" style="display:none">'
    html += '<textarea id="edit-content" rows="4" style="width:100%;font-family:inherit;font-size:13px;padding:8px;border:1px solid var(--stroke);background:var(--bg);resize:vertical">' + escHtml(c.content || '') + '</textarea>'
    html += '<input id="edit-scene" value="' + escAttr(c.scene || '') + '" placeholder="场景" style="width:100%;margin-top:8px;padding:6px 8px;border:1px solid var(--stroke);background:var(--bg);font-size:13px">'
    html += '<input id="edit-tags" value="' + escAttr((c.tags || []).join(', ')) + '" placeholder="标签（逗号分隔）" style="width:100%;margin-top:8px;padding:6px 8px;border:1px solid var(--stroke);background:var(--bg);font-size:13px">'
    html += '<div style="margin-top:8px;display:flex;gap:8px">'
    html += '<button class="edit-save-btn" data-card="' + escAttr(c.id) + '">保存</button>'
    html += '<button class="edit-cancel-btn">取消</button>'
    html += '</div></div>'

    // Action buttons
    html += '<div class="detail-actions">'
    html += '<button class="action-btn edit-btn" data-card="' + escAttr(c.id) + '">编辑</button>'
    html += '<button class="action-btn delete-btn" data-card="' + escAttr(c.id) + '">删除</button>'
    html += '</div>'

    html += '<div class="detail-feedback">'
    var verdicts = [
      { v: 'correct', label: '正确' },
      { v: 'wrong', label: '错误' },
      { v: 'important', label: '重要' },
      { v: 'outdated', label: '过时' }
    ]
    verdicts.forEach(function (vd) {
      html += '<button class="fb-btn" data-card="' + escAttr(c.id) + '" data-verdict="' + vd.v + '">' + vd.label + '</button>'
    })
    html += '</div>'

    panel.innerHTML = html
    panel.classList.add('open')

    // Event listeners
    document.getElementById('detail-close-btn').addEventListener('click', function () {
      panel.classList.remove('open')
    })
    panel.querySelectorAll('.fb-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        submitQuickFeedback(btn.getAttribute('data-card'), btn.getAttribute('data-verdict'))
      })
    })
    // Edit button
    panel.querySelector('.edit-btn').addEventListener('click', function () {
      document.getElementById('detail-edit').style.display = 'block'
      panel.querySelector('.detail-body').style.display = 'none'
    })
    // Edit cancel
    panel.querySelector('.edit-cancel-btn').addEventListener('click', function () {
      document.getElementById('detail-edit').style.display = 'none'
      panel.querySelector('.detail-body').style.display = ''
    })
    // Edit save
    panel.querySelector('.edit-save-btn').addEventListener('click', async function () {
      var cardId = this.getAttribute('data-card')
      var tagStr = document.getElementById('edit-tags').value
      var tags = tagStr.split(/[,，]/).map(function (t) { return t.trim() }).filter(Boolean)
      await api('/api/cards/' + cardId, {
        method: 'PUT',
        body: JSON.stringify({
          content: document.getElementById('edit-content').value,
          scene: document.getElementById('edit-scene').value,
          tags: tags
        })
      })
      showDetail(cardId)
      loadCards()
    })
    // Delete button
    panel.querySelector('.delete-btn').addEventListener('click', async function () {
      var cardId = this.getAttribute('data-card')
      if (!confirm('确定删除这条记忆？')) return
      await api('/api/cards/' + cardId, { method: 'DELETE' })
      panel.classList.remove('open')
      loadCards()
    })
  }

  async function submitQuickFeedback(cardId, verdict) {
    await api('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ card_id: cardId, verdict: verdict })
    })
    document.getElementById('memory-detail').classList.remove('open')
  }

  // Search/filter handlers
  document.getElementById('mem-search').addEventListener('input', debounce(loadCards, 300))
  document.getElementById('mem-tag').addEventListener('change', loadCards)
  document.getElementById('mem-status').addEventListener('change', loadCards)
  document.getElementById('mem-owner').addEventListener('change', loadCards)

  // ============================================
  // Graph
  // ============================================

  function getTagColor(tag) {
    if (!tagColorMap[tag]) {
      var idx = Object.keys(tagColorMap).length
      tagColorMap[tag] = TAG_COLORS[idx % TAG_COLORS.length]
    }
    return tagColorMap[tag]
  }

  async function initGraph() {
    var container = document.getElementById('graph-container')
    var toolbar = document.getElementById('graph-toolbar')
    var tooltip = document.getElementById('graph-tooltip')
    if (!container) return

    var data = await api('/api/graph')
    if (!data || !data.nodes || data.nodes.length === 0) {
      container.innerHTML = '<p style="text-align:center;color:#a0998e;padding:40px">暂无图谱数据</p>'
      return
    }

    // 构建 cytoscape elements
    var elements = []
    data.nodes.forEach(function (n) {
      var color = (n.tags && n.tags.length > 0) ? getTagColor(n.tags[0]) : '#666'
      elements.push({
        group: 'nodes',
        data: {
          id: n.id,
          label: n.content,
          confidence: n.confidence,
          archived: n.archived,
          tags: n.tags || [],
          color: color,
          nodeSize: 8 + (n.confidence || 0.5) * 20,
        }
      })
    })
    data.edges.forEach(function (e) {
      elements.push({
        group: 'edges',
        data: {
          id: e.id || (e.fromId + '-' + e.toId),
          source: e.fromId,
          target: e.toId,
          strength: e.strength || 0.5,
        }
      })
    })

    // 销毁旧实例
    if (cyInstance) { cyInstance.destroy(); cyInstance = null }

    // 创建 cytoscape 实例
    cyInstance = cytoscape({
      container: container,
      elements: elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            'width': 'data(nodeSize)',
            'height': 'data(nodeSize)',
            'border-width': 1.5,
            'border-color': 'data(color)',
            'border-opacity': 0.3,
            'shadow-blur': 10,
            'shadow-color': 'data(color)',
            'shadow-opacity': 0.25,
            'shadow-offset-x': 0,
            'shadow-offset-y': 0,
            'label': 'data(label)',
            'font-size': 9,
            'font-family': 'Inter, system-ui, sans-serif',
            'color': '#5a534b',
            'text-outline-width': 2,
            'text-outline-color': '#f5f0e8',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 6,
            'min-zoomed-font-size': 12,
            'text-max-width': '80px',
            'text-wrap': 'ellipsis',
            'transition-property': 'width, height, shadow-blur, shadow-opacity, border-width, opacity',
            'transition-duration': '0.25s',
          }
        },
        {
          selector: 'node[?archived]',
          style: { 'opacity': 0.15 }
        },
        {
          selector: 'node[confidence >= 0.9]',
          style: {
            'border-width': 2.5,
            'border-opacity': 0.6,
            'shadow-blur': 25,
            'shadow-opacity': 0.7,
          }
        },
        {
          selector: 'edge',
          style: {
            'width': 'mapData(strength, 0, 1, 0.5, 2.5)',
            'line-color': '#ccc7bb',
            'opacity': 0.2,
            'curve-style': 'bezier',
            'transition-property': 'opacity, line-color, width',
            'transition-duration': '0.2s',
          }
        },
        // Hover: 节点发光增强
        {
          selector: 'node.highlight',
          style: {
            'shadow-blur': 35,
            'shadow-opacity': 0.9,
            'border-width': 3,
            'border-opacity': 0.8,
            'color': '#2c2c2c',
            'font-size': 11,
            'min-zoomed-font-size': 0,
            'z-index': 999,
          }
        },
        // 邻居节点
        {
          selector: 'node.neighbor',
          style: {
            'opacity': 0.85,
            'shadow-blur': 10,
            'shadow-opacity': 0.4,
            'min-zoomed-font-size': 0,
            'color': '#8a8279',
          }
        },
        // 邻居连线
        {
          selector: 'edge.highlight',
          style: {
            'opacity': 0.6,
            'width': 2,
            'line-color': '#a09890',
          }
        },
        // 淡化非相关
        {
          selector: 'node.faded',
          style: { 'opacity': 0.06 }
        },
        {
          selector: 'edge.faded',
          style: { 'opacity': 0.02 }
        },
      ],
      layout: {
        name: 'cose',
        animate: false,
        nodeRepulsion: function () { return 8000 },
        idealEdgeLength: function () { return 100 },
        gravity: 0.25,
        numIter: 400,
        nodeDimensionsIncludeLabels: false,
      },
      userZoomingEnabled: true,
      userPanningEnabled: true,
      minZoom: 0.15,
      maxZoom: 5,
      boxSelectionEnabled: false,
      selectionType: 'single',
      textureOnViewport: true,
      hideEdgesOnViewport: true,
    })

    // Hover: 渐进放大聚焦节点及其连接
    var hoverRestoreTimer = null
    var isHovering = false

    cyInstance.on('mouseover', 'node', function (evt) {
      var node = evt.target
      var neighborhood = node.neighborhood()
      isHovering = true

      // 清除恢复全局视图的定时器
      if (hoverRestoreTimer) { clearTimeout(hoverRestoreTimer); hoverRestoreTimer = null }

      // 高亮 / 淡化
      cyInstance.elements().addClass('faded')
      node.removeClass('faded').addClass('highlight')
      neighborhood.nodes().removeClass('faded').addClass('neighbor')
      neighborhood.edges().removeClass('faded').addClass('highlight')

      // 取消正在进行的动画，防止叠加抖动
      cyInstance.stop()
      // 动画放大到当前节点 + 邻域
      var focusEles = node.union(neighborhood)
      cyInstance.animate({
        fit: { eles: focusEles, padding: 60 },
      }, { duration: 400, easing: 'ease-out-cubic' })

      // Tooltip
      var pos = evt.renderedPosition
      var rect = container.getBoundingClientRect()
      var tags = (node.data('tags') || []).join(' · ')
      tooltip.innerHTML = '<div class="gt-title">' + escHtml(truncate(node.data('label'), 100)) + '</div>'
        + (tags ? '<div class="gt-tags">' + escHtml(tags) + '</div>' : '')
        + '<div class="gt-meta">置信度 ' + (node.data('confidence') || 0).toFixed(2) + ' · 连接 ' + neighborhood.edges().length + '</div>'
      tooltip.style.left = (rect.left + pos.x + 15) + 'px'
      tooltip.style.top = (rect.top + pos.y - 10) + 'px'
      tooltip.style.display = 'block'
    })
    cyInstance.on('mouseout', 'node', function () {
      isHovering = false
      cyInstance.elements().removeClass('faded highlight neighbor')
      tooltip.style.display = 'none'

      // 延迟恢复全局概览（避免在节点间快速移动时频繁缩放）
      hoverRestoreTimer = setTimeout(function () {
        if (!isHovering && cyInstance) {
          cyInstance.stop()
          cyInstance.animate({
            fit: { eles: cyInstance.elements(':visible'), padding: 30 },
          }, { duration: 500, easing: 'ease-out-cubic' })
        }
      }, 600)
    })

    // 点击跳转详情
    cyInstance.on('tap', 'node', function (evt) {
      showDetail(evt.target.id())
    })

    // 工具栏
    toolbar.innerHTML = '<div class="graph-filters">'
      + '<label>置信度 ≥ <span id="conf-value">0.00</span></label>'
      + '<input type="range" id="conf-slider" min="0" max="100" value="0">'
      + '<button id="graph-fit-btn" class="graph-btn">适应</button>'
      + '<span id="graph-stats" class="graph-stats"></span>'
      + '</div>'

    // 统计
    var visibleCount = data.nodes.length
    document.getElementById('graph-stats').textContent = visibleCount + ' 节点 · ' + data.edges.length + ' 连接'

    var slider = document.getElementById('conf-slider')
    slider.addEventListener('input', function () {
      confThreshold = parseInt(this.value) / 100
      document.getElementById('conf-value').textContent = confThreshold.toFixed(2)
      applyGraphFilter()
    })

    document.getElementById('graph-fit-btn').addEventListener('click', function () {
      cyInstance.fit(undefined, 30)
    })

    // 默认阈值
    if (data.nodes.length > 80) {
      confThreshold = 0.7
      slider.value = '70'
      document.getElementById('conf-value').textContent = '0.70'
      applyGraphFilter()
    }
  }

  function applyGraphFilter() {
    if (!cyInstance) return
    var visible = 0
    cyInstance.batch(function () {
      cyInstance.nodes().forEach(function (n) {
        if (n.data('confidence') < confThreshold) {
          n.style('display', 'none')
        } else {
          n.style('display', 'element')
          visible++
        }
      })
    })
    var statsEl = document.getElementById('graph-stats')
    if (statsEl) statsEl.textContent = visible + ' 节点'
  }

  // ---- 旧图谱代码已移除 ----
  function assignTagColors(nodes) {
    var allTags = {}
    nodes.forEach(function (n) {
      (n.tags || []).forEach(function (t) { allTags[t] = true })
    })
    var idx = 0
    for (var tag in allTags) {
      if (!tagColorMap[tag]) {
        tagColorMap[tag] = TAG_COLORS[idx % TAG_COLORS.length]
        idx++
      }
    }
  }


  // Instances
  // ============================================

  async function loadInstances() {
    // 对话/日志面板打开时跳过自动刷新（避免丢失面板状态）
    var container = document.getElementById('instances-content')
    if (container) {
      var openPanels = container.querySelectorAll('.conversation-panel, .instance-terminal-panel')
      for (var i = 0; i < openPanels.length; i++) {
        if (openPanels[i].style.display !== 'none') return
      }
    }

    var data = await api('/api/instances')
    if (!data) {
      document.getElementById('instances-content').innerHTML =
        '<p class="empty-state">无法加载实例数据</p>'
      return
    }
    var instances = Array.isArray(data) ? data : (data.instances || [])
    if (instances.length === 0) {
      document.getElementById('instances-content').innerHTML =
        '<p class="empty-state">暂无实例</p>'
      return
    }

    // 按 parentId 分组：有 parentId 且能找到父实例的作为子节点，否则作为根节点
    var parentIds = {}
    instances.forEach(function (i) { parentIds[i.id] = true })

    var roots = instances.filter(function (i) {
      return !i.parentId || !parentIds[i.parentId]
    })
    var children = instances.filter(function (i) {
      return i.parentId && parentIds[i.parentId]
    })

    // 建索引
    var childrenMap = {}
    children.forEach(function (c) {
      if (!childrenMap[c.parentId]) childrenMap[c.parentId] = []
      childrenMap[c.parentId].push(c)
    })

    // 如果没有实际的父子关系，按 role 排序（main > specialist > worker）
    var roleOrder = { main: 0, specialist: 1, worker: 2 }
    roots.sort(function (a, b) {
      return (roleOrder[a.role] || 9) - (roleOrder[b.role] || 9)
    })

    // 按 role 分组显示
    var roleLabels = { main: '主实例', specialist: '专员', worker: '工人' }
    var lastRole = ''
    var html = ''

    function renderNode(inst, depth) {
      var state = inst.state || 'unknown'
      var dotClass = state === 'running' ? 'healthy' :
        state === 'sleeping' ? 'idle' :
        state === 'zombie' ? 'error' : 'idle'
      var detailId = 'inst-detail-' + inst.id.replace(/[^a-z0-9]/gi, '-')
      var convId = inst.symbiontSessionId ? 'inst-conv-' + inst.id.replace(/[^a-z0-9]/gi, '-') : null
      var depthClass = depth > 0 ? ' instance-child' : ''

      var termId = 'inst-term-' + inst.id.replace(/[^a-z0-9]/gi, '-')

      var s = '<div class="instance-node' + depthClass + '" data-instance-id="' + escHtml(inst.id) + '" style="margin-left:' + (depth * 28) + 'px">'
      s += '<div class="instance-row">'
      s += '<div class="instance-state"><span class="status-dot ' + dotClass + '"></span></div>'
      s += '<div class="instance-info">'
      s += '<div class="instance-id">' + escHtml(inst.id || '') + '</div>'
      s += '<div class="instance-role">' + escHtml(inst.role || '-') + ' &middot; ' + escHtml(state)
      if (inst.sessionKey) {
        s += ' &middot; <span class="instance-session-key">' + escHtml(inst.sessionKey) + '</span>'
      }
      s += '</div>'

      // Token usage + model
      if (inst.usage && inst.usage.contextWindow > 0) {
        var inputK = Math.round(inst.usage.inputTokens / 1000)
        var ctxM = (inst.usage.contextWindow / 1000000).toFixed(1)
        var pct = Math.round((inst.usage.inputTokens / inst.usage.contextWindow) * 100)
        var pctColor = pct >= 50 ? 'var(--vermillion)' : pct >= 30 ? '#c89b3c' : 'var(--jade)'
        var modelShort = inst.usage.model ? inst.usage.model.replace(/^claude-/, '').replace(/-\d{8}$/, '') : ''
        s += '<div class="instance-usage">'
        if (modelShort) s += '<span class="instance-model">' + escHtml(modelShort) + '</span>'
        s += '<span class="instance-tokens">' + inputK + 'k/' + ctxM + 'm</span>'
        s += '<span class="instance-pct" style="color:' + pctColor + '">(' + pct + '%)</span>'
        s += '<span class="instance-usage-bar"><span class="instance-usage-fill" style="width:' + Math.min(pct, 100) + '%;background:' + pctColor + '"></span></span>'
        s += '</div>'
      }

      if (inst.description) {
        s += '<div class="instance-desc">' + escHtml(inst.description) + '</div>'
      }

      // 最近 3 条活动（摘要）
      var activities = inst.activities || []
      if (activities.length > 0) {
        s += '<div class="instance-activities">'
        var recent = activities.slice(-3).reverse()
        recent.forEach(function (act) {
          var icon = act.type === 'tool_use' ? '\u2699' : act.type === 'reply' ? '\u{1F4E8}' : act.type === 'text' ? '\u{1F4AC}' : '\u00B7'
          var time = act.ts ? act.ts.slice(11, 19) : ''
          s += '<div class="instance-activity">'
          s += '<span class="activity-time">' + escHtml(time) + '</span> '
          s += '<span class="activity-icon">' + icon + '</span> '
          s += '<span class="activity-detail">' + escHtml(act.detail || '') + '</span>'
          s += '</div>'
        })
        s += '</div>'
      }

      s += '</div>'
      s += '<div class="instance-meta">'
      if (inst.sessionId) {
        s += '<div>\u4F1A\u8BDD ' + escHtml(truncate(inst.sessionId, 12)) + '</div>'
      }
      s += '<div>' + relativeTime(inst.createdAt) + '</div>'
      s += '<button class="instance-detail-btn" data-detail="' + detailId + '">\u8BE6\u60C5</button>'
      s += '<button class="instance-detail-btn instance-term-btn" data-term="' + termId + '" data-inst-id="' + escHtml(inst.id) + '">\u65E5\u5FD7</button>'
      if (convId) {
        s += '<button class="instance-detail-btn instance-conv-btn" data-conv="' + convId + '" data-symbiont-session="' + escHtml(inst.symbiontSessionId) + '">\u5BF9\u8BDD</button>'
      }
      s += '</div>'
      s += '</div>' // .instance-row

      // 详情展开面板（默认隐藏）
      s += '<div class="instance-detail-panel" id="' + detailId + '" style="display:none">'
      if (activities.length > 0) {
        s += '<div class="detail-panel-title">\u5168\u90E8\u6D3B\u52A8 (' + activities.length + ')</div>'
        activities.slice().reverse().forEach(function (act) {
          var icon = act.type === 'tool_use' ? '\u2699' : act.type === 'reply' ? '\u{1F4E8}' : act.type === 'text' ? '\u{1F4AC}' : '\u00B7'
          var time = act.ts ? act.ts.slice(11, 19) : ''
          s += '<div class="detail-activity">'
          s += '<span class="activity-time">' + escHtml(time) + '</span> '
          s += '<span class="activity-icon">' + icon + '</span> '
          s += '<span class="activity-type">[' + escHtml(act.type || '') + ']</span> '
          s += '<span class="activity-detail">' + escHtml(act.detail || '') + '</span>'
          s += '</div>'
        })
      } else {
        s += '<div class="detail-panel-empty">\u65E0\u6D3B\u52A8\u8BB0\u5F55</div>'
      }
      s += '</div>' // .instance-detail-panel

      // 对话面板（默认隐藏）
      if (convId) {
        s += '<div class="conversation-panel" id="' + convId + '" style="display:none">'
        s += '<div class="conv-empty">\u52A0\u8F7D\u4E2D...</div>'
        s += '</div>'
      }

      // 终端日志面板（默认隐藏）
      s += '<div class="instance-terminal-panel" id="' + termId + '" style="display:none">'
      s += '<div class="terminal-header">'
      s += '<span class="terminal-title">\u5B9E\u65F6\u65E5\u5FD7</span>'
      s += '<button class="terminal-close" data-term-close="' + termId + '" data-inst-id="' + escHtml(inst.id) + '">\u2715</button>'
      s += '</div>'
      s += '<div class="instance-terminal" id="termlog-' + inst.id.replace(/[^a-z0-9]/gi, '-') + '">'
      s += '<div class="terminal-placeholder">\u7B49\u5F85\u8F93\u51FA...</div>'
      s += '</div>'
      s += '</div>'

      s += '</div>' // .instance-node
      return s
    }

    roots.forEach(function (root) {
      // 角色分组标题
      if (root.role !== lastRole) {
        lastRole = root.role
        html += '<div class="instance-group-label">' + escHtml(roleLabels[root.role] || root.role) + '</div>'
      }
      html += renderNode(root, 0)
      var subs = childrenMap[root.id] || []
      subs.forEach(function (sub) {
        html += renderNode(sub, 1)
      })
    })

    var container = document.getElementById('instances-content')
    container.innerHTML = html

    // 绑定详情按钮点击事件
    container.querySelectorAll('.instance-detail-btn:not(.instance-conv-btn)').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var panelId = btn.getAttribute('data-detail')
        var panel = document.getElementById(panelId)
        if (!panel) return
        var isVisible = panel.style.display !== 'none'
        panel.style.display = isVisible ? 'none' : 'block'
        btn.textContent = isVisible ? '\u8BE6\u60C5' : '\u6536\u8D77'
      })
    })

    // 绑定对话按钮点击事件
    container.querySelectorAll('.instance-conv-btn').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var convId = btn.getAttribute('data-conv')
        var siaSession = btn.getAttribute('data-symbiont-session')
        var panel = document.getElementById(convId)
        if (!panel) return

        var isVisible = panel.style.display !== 'none'
        if (isVisible) {
          panel.style.display = 'none'
          btn.textContent = '\u5BF9\u8BDD'
          currentConversationSessionId = null
          currentConversationData = null
          currentConversationPanelId = null
          return
        }

        btn.textContent = '\u52A0\u8F7D\u4E2D...'
        currentConversationSessionId = siaSession
        currentConversationPanelId = convId
        try {
          var msgs = await api('/api/conversation/' + encodeURIComponent(siaSession))
          if (!msgs || msgs.length === 0) {
            panel.innerHTML = '<div class="conv-empty">\u65E0\u5BF9\u8BDD\u8BB0\u5F55</div>'
            currentConversationData = []
          } else {
            currentConversationData = msgs
            renderConversationPanel(msgs)
          }
        } catch (err) {
          panel.innerHTML = '<div class="conv-empty">\u52A0\u8F7D\u5931\u8D25</div>'
        }
        panel.style.display = 'block'
        btn.textContent = '\u6536\u8D77\u5BF9\u8BDD'
      })
    })

    // 绑定日志按钮点击事件
    container.querySelectorAll('.instance-term-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var termId = btn.getAttribute('data-term')
        var instId = btn.getAttribute('data-inst-id')
        var panel = document.getElementById(termId)
        if (!panel) return
        var isVisible = panel.style.display !== 'none'
        if (isVisible) {
          panel.style.display = 'none'
          btn.textContent = '\u65E5\u5FD7'
          stopInstanceLog(instId)
        } else {
          panel.style.display = 'block'
          btn.textContent = '\u6536\u8D77\u65E5\u5FD7'
          startInstanceLog(instId)
        }
      })
    })

    // 绑定终端面板关闭按钮
    container.querySelectorAll('.terminal-close').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var termId = btn.getAttribute('data-term-close')
        var instId = btn.getAttribute('data-inst-id')
        var panel = document.getElementById(termId)
        if (panel) panel.style.display = 'none'
        stopInstanceLog(instId)
        // 还原按钮文本
        var termBtn = container.querySelector('.instance-term-btn[data-term="' + termId + '"]')
        if (termBtn) termBtn.textContent = '\u65E5\u5FD7'
      })
    })
  }

  // ============================================
  // Instance Terminal Log (SSE)
  // ============================================

  var instanceLogHandlers = {}

  function startInstanceLog(instanceId) {
    if (instanceLogHandlers[instanceId]) return // already listening
    var termKey = 'termlog-' + instanceId.replace(/[^a-z0-9]/gi, '-')
    if (!eventSource) return

    var handler = function (e) {
      try {
        var data = JSON.parse(e.data)
        if (data.instanceId !== instanceId) return

        // 每次事件都重新查找 DOM 元素（防止 loadInstances 重渲染后引用失效）
        var terminal = document.getElementById(termKey)
        if (!terminal) return

        // Remove placeholder
        var placeholder = terminal.querySelector('.terminal-placeholder')
        if (placeholder) placeholder.remove()

        var line = document.createElement('div')
        line.className = 'terminal-line' + (data.stream === 'stderr' ? ' terminal-stderr' : '')
        line.textContent = data.text
        terminal.appendChild(line)

        // Cap at 500 lines
        while (terminal.children.length > 500) {
          terminal.removeChild(terminal.firstChild)
        }

        // Auto-scroll
        terminal.scrollTop = terminal.scrollHeight
      } catch (err) { /* ignore parse errors */ }
    }

    eventSource.addEventListener('instance.output', handler)
    instanceLogHandlers[instanceId] = handler
  }

  function stopInstanceLog(instanceId) {
    var handler = instanceLogHandlers[instanceId]
    if (!handler) return
    if (eventSource) {
      eventSource.removeEventListener('instance.output', handler)
    }
    delete instanceLogHandlers[instanceId]
  }

  // ============================================
  // Cron
  // ============================================

  async function loadCron() {
    var data = await api('/api/cron')
    if (!data) {
      document.getElementById('cron-content').innerHTML =
        '<p class="empty-state">无法加载定时任务</p>'
      return
    }

    var running = data.running
    var jobs = data.jobs || []

    var html = '<div class="cron-header">'
    html += '<h3>定时调度</h3>'
    html += running
      ? '<span class="cron-running-badge">运行中</span>'
      : '<span class="cron-stopped-badge">已停止</span>'
    html += '</div>'

    if (jobs.length === 0) {
      html += '<p class="empty-state">暂无定时任务</p>'
    } else {
      html += jobs.map(function (job) {
        var failures = job.consecutiveFailures || job.failures || 0
        var enabled = job.enabled !== false
        return '<div class="cron-row">' +
          '<div class="cron-name">' + escHtml(job.name || job.id || '-') +
          '<button class="cron-history-btn" data-job-id="' + escHtml(job.id || '') + '">历史</button>' +
          '</div>' +
          '<div class="cron-schedule">' + escHtml(job.schedule || job.cron || '-') + '</div>' +
          '<div class="cron-enabled" style="color:' + (enabled ? 'var(--jade)' : 'var(--ink-faint)') + '">' +
          (enabled ? '启用' : '禁用') + '</div>' +
          '<div class="cron-failures' + (failures > 0 ? ' has-failures' : '') + '">' +
          (failures > 0 ? '连续失败 ' + failures : '') +
          (job.lastRun ? '<br>' + relativeTime(job.lastRun) : '') +
          '</div>' +
          '</div>'
      }).join('')
    }

    document.getElementById('cron-content').innerHTML = html
  }

  document.addEventListener('click', function (e) {
    if (e.target.classList.contains('cron-history-btn')) {
      var jobId = e.target.getAttribute('data-job-id')
      if (jobId) toggleCronHistory(jobId, e.target)
    }
  })

  async function toggleCronHistory(jobId, btn) {
    var cronRow = btn.closest('.cron-row')
    var existing = cronRow.nextElementSibling
    if (existing && existing.classList.contains('cron-history')) {
      existing.remove()
      return
    }

    var runs = await api('/api/cron/runs?jobId=' + encodeURIComponent(jobId) + '&limit=20')
    var html = '<div class="cron-history"><table class="cron-runs-table">'
    html += '<tr><th>时间</th><th>状态</th><th>耗时</th><th>错误</th></tr>'
    if (!runs || runs.length === 0) {
      html += '<tr><td colspan="4" class="empty">暂无执行记录</td></tr>'
    } else {
      runs.forEach(function (r) {
        var statusIcon = r.status === 'completed' ? '✓' : r.status === 'failed' ? '✗' : r.status === 'skipped' ? '⏭' : '…'
        var statusClass = 'run-' + r.status
        var duration = r.duration ? (r.duration / 1000).toFixed(1) + 's' : '-'
        var time = new Date(r.startedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        html += '<tr class="' + statusClass + '">'
        html += '<td>' + time + '</td>'
        html += '<td>' + statusIcon + ' ' + r.status + '</td>'
        html += '<td>' + duration + '</td>'
        html += '<td>' + escHtml(r.error || '-') + '</td>'
        html += '</tr>'
      })
    }
    html += '</table></div>'
    cronRow.insertAdjacentHTML('afterend', html)
  }

  // ============================================
  // Activity
  // ============================================

  async function loadActivity() {
    var data = await api('/api/activity?limit=50')
    if (!data) {
      document.getElementById('activity-content').innerHTML =
        '<p class="empty-state">无法加载活动日志</p>'
      return
    }
    var items = Array.isArray(data) ? data : (data.activities || [])
    if (items.length === 0) {
      document.getElementById('activity-content').innerHTML =
        '<p class="empty-state">暂无活动记录</p>'
      return
    }

    var typeLabels = {
      create: '创建',
      update: '更新',
      archive: '归档',
      feedback: '反馈',
      merge: '合并',
      decay: '衰减',
      cognition: '认知',
      search: '搜索',
      settle: '沉淀'
    }

    document.getElementById('activity-content').innerHTML = items.map(function (a, idx) {
      var type = a.type || 'event'
      var label = typeLabels[type] || type
      var detail = a.detail || a.description || ''
      // settle/compile 的 detail 是 JSON，尝试解析为可读文本
      var displayDetail = detail
      var rawDetail = detail
      if (detail.startsWith('{')) {
        try {
          var parsed = JSON.parse(detail)
          var parts = []
          if (parsed.settled) parts.push('沉淀 ' + parsed.settled + ' 张')
          if (parsed.decayed) parts.push('衰减 ' + parsed.decayed + ' 张')
          if (parsed.compiled) parts.push('编译 ' + parsed.compiled + ' 条')
          if (parsed.tag) parts.push(parsed.tag)
          if (parsed.summary) parts.push(parsed.summary)
          if (parts.length) displayDetail = parts.join('，')
          rawDetail = JSON.stringify(parsed, null, 2)
        } catch {}
      }

      var hasDetail = rawDetail && rawDetail.length > 0
      var cardId = a.cardId || a.card_id || null
      var sessionId = a.sessionId || a.session_id || null
      var expandable = hasDetail || cardId || sessionId
      var expandId = 'activity-expand-' + idx

      var html = '<div class="activity-item' + (expandable ? ' expandable' : '') + '"'
      if (expandable) html += ' data-expand="' + expandId + '"'
      html += '>'
      html += '<span class="activity-time">' + formatDate(a.createdAt || a.created_at || a.timestamp) + '</span>'
      html += '<span class="activity-type">' + escHtml(label) + '</span>'
      html += '<span class="activity-detail">' + escHtml(displayDetail) + '</span>'
      if (expandable) html += '<span class="activity-arrow">▸</span>'
      html += '</div>'

      // 展开区域
      if (expandable) {
        html += '<div class="activity-expand" id="' + expandId + '" style="display:none">'
        if (cardId) {
          html += '<div class="activity-expand-label" data-card-id="' + escAttr(cardId) + '">关联卡片: ' + escHtml(cardId) + '</div>'
        }
        if (sessionId) {
          html += '<div class="activity-expand-label" data-session-id="' + escAttr(sessionId) + '">会话: ' + escHtml(sessionId) + ' <button class="load-context-btn">查看上下文</button></div>'
          html += '<div class="activity-context" style="display:none"></div>'
        }
        if (hasDetail) {
          html += '<pre class="activity-expand-raw">' + escHtml(rawDetail) + '</pre>'
        }
        html += '</div>'
      }

      return html
    }).join('')

    // 绑定点击展开
    document.querySelectorAll('.activity-item.expandable').forEach(function (item) {
      item.addEventListener('click', async function () {
        var expandId = item.getAttribute('data-expand')
        var expand = document.getElementById(expandId)
        if (!expand) return
        var isOpen = expand.style.display !== 'none'
        expand.style.display = isOpen ? 'none' : 'block'
        var arrow = item.querySelector('.activity-arrow')
        if (arrow) arrow.textContent = isOpen ? '▸' : '▾'

        // 首次展开时，异步加载关联数据
        if (!isOpen && expand.getAttribute('data-loaded') !== 'true') {
          // 加载关联卡片
          var cardLabel = expand.querySelector('[data-card-id]')
          if (cardLabel) {
            var cardId = cardLabel.getAttribute('data-card-id')
            try {
              var card = await api('/api/cards/' + encodeURIComponent(cardId))
              if (card && card.content) {
                var cardHtml = '<div class="activity-card-detail">'
                cardHtml += '<div><strong>内容：</strong>' + escHtml(card.content) + '</div>'
                cardHtml += '<div><strong>场景：</strong>' + escHtml(card.scene || '-') + '</div>'
                if (card.tags) cardHtml += '<div><strong>标签：</strong>' + escHtml(card.tags) + '</div>'
                if (card.owner) cardHtml += '<div><strong>归属：</strong>' + escHtml(card.owner) + '</div>'
                cardHtml += '<div><strong>置信度：</strong>' + (card.confidence || 0).toFixed(2) + '</div>'
                cardHtml += '</div>'
                cardLabel.innerHTML = '关联卡片: ' + escHtml(cardId) + cardHtml
              }
            } catch (e) { /* ignore */ }
          }
          expand.setAttribute('data-loaded', 'true')
        }
      })
    })

    // 绑定"查看上下文"按钮（阻止冒泡到父级 expand toggle）
    document.querySelectorAll('.load-context-btn').forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.stopPropagation()
        var label = btn.parentElement
        var sessionId = label ? label.getAttribute('data-session-id') : null
        if (!sessionId) return
        var contextEl = label.nextElementSibling
        if (!contextEl) return

        if (contextEl.style.display !== 'none') {
          contextEl.style.display = 'none'
          btn.textContent = '查看上下文'
          return
        }

        btn.textContent = '加载中...'
        try {
          var events = await api('/api/events/' + encodeURIComponent(sessionId))
          if (!events || events.length === 0) {
            contextEl.innerHTML = '<div class="context-empty">无对话记录</div>'
          } else {
            var ctxHtml = '<div class="context-list">'
            events.forEach(function (evt) {
              var role = evt.role || evt.type || '?'
              var content = evt.content || ''
              if (content.length > 300) content = content.slice(0, 300) + '...'
              ctxHtml += '<div class="context-msg">'
              ctxHtml += '<span class="context-role">' + escHtml(role) + '</span>'
              ctxHtml += '<span class="context-content">' + escHtml(content) + '</span>'
              ctxHtml += '</div>'
            })
            ctxHtml += '</div>'
            contextEl.innerHTML = ctxHtml
          }
        } catch (err) {
          contextEl.innerHTML = '<div class="context-empty">加载失败</div>'
        }
        contextEl.style.display = 'block'
        btn.textContent = '收起上下文'
      })
    })
  }

  // ============================================
  // Tasks
  // ============================================

  var editingTaskId = null

  async function loadTasks() {
    var params = new URLSearchParams()
    var statusEl = document.getElementById('task-status-filter')
    var assigneeEl = document.getElementById('task-assignee-filter')
    if (statusEl && statusEl.value) params.set('status', statusEl.value)
    if (assigneeEl && assigneeEl.value) params.set('assignee', assigneeEl.value)

    var data = await api('/api/tasks?' + params)
    if (!data) {
      document.getElementById('tasks-content').innerHTML =
        '<p class="empty-state">无法加载任务数据</p>'
      return
    }

    var tasks = Array.isArray(data) ? data : []
    if (tasks.length === 0) {
      document.getElementById('tasks-content').innerHTML =
        '<p class="empty-state">暂无任务</p>'
      return
    }

    // Group by status
    var groups = { todo: [], doing: [], done: [], cancelled: [] }
    tasks.forEach(function (t) {
      var s = t.status || 'todo'
      if (groups[s]) groups[s].push(t)
      else groups.todo.push(t)
    })

    var groupLabels = { todo: '待办', doing: '进行中', done: '已完成', cancelled: '已取消' }
    var html = ''

    ;['todo', 'doing', 'done', 'cancelled'].forEach(function (status) {
      var items = groups[status]
      if (items.length === 0) return

      html += '<div class="task-group">'
      html += '<div class="task-group-header">' + groupLabels[status] +
        ' <span class="task-group-count">(' + items.length + ')</span></div>'

      items.forEach(function (t) {
        html += renderTaskRow(t)
      })
      html += '</div>'
    })

    document.getElementById('tasks-content').innerHTML = html
    bindTaskActions()
  }

  function renderTaskRow(t) {
    var titleClass = 'task-title'
    if (t.status === 'done') titleClass += ' done'
    if (t.status === 'cancelled') titleClass += ' cancelled'

    var priorityLabels = { urgent: '紧急', high: '高', normal: '普通', low: '低' }
    var assigneeLabels = { xiaoxi: '小希', yilin: '以琳' }

    // Check if overdue
    var isOverdue = false
    if (t.due_date && t.status !== 'done' && t.status !== 'cancelled') {
      var dueDate = new Date(t.due_date + 'T23:59:59')
      if (dueDate < new Date()) isOverdue = true
    }

    var html = '<div class="task-row" data-id="' + escAttr(t.id) + '">'
    html += '<div>'

    // Title line
    html += '<div class="task-title-line">'
    html += '<span class="' + titleClass + '">' + escHtml(t.title) + '</span>'
    html += '</div>'

    // Description
    if (t.description) {
      html += '<div class="task-desc">' + escHtml(truncate(t.description, 120)) + '</div>'
    }

    // Meta
    html += '<div class="task-meta">'
    html += '<span class="task-priority ' + (t.priority || 'normal') + '">' +
      (priorityLabels[t.priority] || t.priority || '普通') + '</span>'
    html += '<span class="task-assignee">' + escHtml(assigneeLabels[t.assignee] || t.assignee || '小希') + '</span>'
    if (t.due_date) {
      html += '<span class="task-due' + (isOverdue ? ' overdue' : '') + '">'
      html += (isOverdue ? '已过期 ' : '截止 ') + escHtml(t.due_date)
      html += '</span>'
    }
    html += '<span class="task-time">' + relativeTime(t.created_at) + '</span>'
    if (t.completed_at) {
      html += '<span class="task-time" style="color:var(--jade)">完成于 ' + formatDate(t.completed_at) + '</span>'
    }
    html += '</div>'

    html += '</div>'

    // Actions
    html += '<div class="task-actions">'
    if (t.status === 'todo') {
      html += '<button class="task-status-btn start" data-id="' + escAttr(t.id) + '" data-action="doing">开始</button>'
      html += '<button class="task-status-btn complete" data-id="' + escAttr(t.id) + '" data-action="done">完成</button>'
    }
    if (t.status === 'doing') {
      html += '<button class="task-status-btn complete" data-id="' + escAttr(t.id) + '" data-action="done">完成</button>'
      html += '<button class="task-status-btn" data-id="' + escAttr(t.id) + '" data-action="todo">退回</button>'
    }
    if (t.status === 'done' || t.status === 'cancelled') {
      html += '<button class="task-status-btn" data-id="' + escAttr(t.id) + '" data-action="todo">重开</button>'
    }
    if (t.status !== 'cancelled' && t.status !== 'done') {
      html += '<button class="task-status-btn cancel" data-id="' + escAttr(t.id) + '" data-action="cancelled">取消</button>'
    }
    html += '<button class="task-status-btn edit" data-id="' + escAttr(t.id) + '" data-action="edit">编辑</button>'
    html += '<button class="task-status-btn delete" data-id="' + escAttr(t.id) + '" data-action="delete">删除</button>'
    html += '</div>'

    html += '</div>'
    return html
  }

  function bindTaskActions() {
    document.querySelectorAll('.task-status-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        var id = btn.getAttribute('data-id')
        var action = btn.getAttribute('data-action')

        if (action === 'delete') {
          if (!confirm('确定删除这个任务？')) return
          api('/api/tasks/' + id, { method: 'DELETE' }).then(function () { loadTasks() })
          return
        }

        if (action === 'edit') {
          openTaskEditor(id)
          return
        }

        // Status change
        api('/api/tasks/' + id, {
          method: 'PUT',
          body: JSON.stringify({ status: action })
        }).then(function () { loadTasks() })
      })
    })
  }

  function openTaskEditor(taskId) {
    editingTaskId = taskId || null
    var overlay = document.getElementById('task-edit-overlay')
    overlay.style.display = 'flex'

    document.getElementById('task-edit-title').textContent = taskId ? '编辑任务' : '新建任务'
    document.getElementById('task-input-title').value = ''
    document.getElementById('task-input-desc').value = ''
    document.getElementById('task-input-assignee').value = 'xiaoxi'
    document.getElementById('task-input-priority').value = 'normal'
    document.getElementById('task-input-due').value = ''

    if (taskId) {
      // Find existing task from DOM
      api('/api/tasks').then(function (tasks) {
        if (!tasks) return
        var t = tasks.find(function (x) { return x.id === taskId })
        if (!t) return
        document.getElementById('task-input-title').value = t.title || ''
        document.getElementById('task-input-desc').value = t.description || ''
        document.getElementById('task-input-assignee').value = t.assignee || 'xiaoxi'
        document.getElementById('task-input-priority').value = t.priority || 'normal'
        document.getElementById('task-input-due').value = t.due_date ? t.due_date.slice(0, 10) : ''
      })
    }
  }

  function closeTaskEditor() {
    document.getElementById('task-edit-overlay').style.display = 'none'
    editingTaskId = null
  }

  function saveTask() {
    var title = document.getElementById('task-input-title').value.trim()
    if (!title) return

    var data = {
      title: title,
      description: document.getElementById('task-input-desc').value.trim() || undefined,
      assignee: document.getElementById('task-input-assignee').value,
      priority: document.getElementById('task-input-priority').value,
      due_date: document.getElementById('task-input-due').value || undefined,
    }

    if (editingTaskId) {
      api('/api/tasks/' + editingTaskId, {
        method: 'PUT',
        body: JSON.stringify(data)
      }).then(function () {
        closeTaskEditor()
        loadTasks()
      })
    } else {
      data.created_by = 'yilin'
      api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(data)
      }).then(function () {
        closeTaskEditor()
        loadTasks()
      })
    }
  }

  // Task event listeners (deferred until DOM ready)
  setTimeout(function () {
    var addBtn = document.getElementById('task-add-btn')
    if (addBtn) addBtn.addEventListener('click', function () { openTaskEditor(null) })

    var saveBtn = document.getElementById('task-save-btn')
    if (saveBtn) saveBtn.addEventListener('click', saveTask)

    var cancelBtn = document.getElementById('task-cancel-btn')
    if (cancelBtn) cancelBtn.addEventListener('click', closeTaskEditor)

    var overlay = document.getElementById('task-edit-overlay')
    if (overlay) overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeTaskEditor()
    })

    var statusFilter = document.getElementById('task-status-filter')
    if (statusFilter) statusFilter.addEventListener('change', loadTasks)

    var assigneeFilter = document.getElementById('task-assignee-filter')
    if (assigneeFilter) assigneeFilter.addEventListener('change', loadTasks)
  }, 0)

  // ============================================
  // Wishes
  // ============================================

  var wishFilter = ''

  async function loadWishes() {
    var params = wishFilter ? '?status=' + wishFilter : ''
    var data = await api('/api/wishes' + params)
    if (!data) {
      document.getElementById('wishes-content').innerHTML =
        '<p class="empty-state">无法加载许愿池</p>'
      return
    }
    var wishes = Array.isArray(data) ? data : []
    renderWishes(wishes)
  }

  function renderWishes(wishes) {
    var container = document.getElementById('wishes-content')

    var pending = wishes.filter(function (w) { return w.status === 'pending' }).length
    var accepted = wishes.filter(function (w) { return w.status === 'accepted' }).length
    var done = wishes.filter(function (w) { return w.status === 'done' }).length

    var html = '<div class="wishes-header">'
    html += '<h3>许愿池</h3>'
    html += '<div class="wishes-stats">'
    html += '<span>待审 ' + pending + '</span>'
    html += '<span>已批准 ' + accepted + '</span>'
    html += '<span>已实现 ' + done + '</span>'
    html += '</div></div>'

    // Filter buttons
    html += '<div class="wish-filter">'
    var filters = [
      { value: '', label: '全部' },
      { value: 'pending', label: '待审' },
      { value: 'accepted', label: '已批准' },
      { value: 'done', label: '已实现' },
      { value: 'rejected', label: '已拒绝' }
    ]
    filters.forEach(function (f) {
      html += '<button class="wish-filter-btn' + (wishFilter === f.value ? ' active' : '') + '" data-filter="' + f.value + '">' + f.label + '</button>'
    })
    html += '</div>'

    if (wishes.length === 0) {
      html += '<p class="empty-state">许愿池空空如也</p>'
    } else {
      html += wishes.map(function (w) {
        var statusLabels = { pending: '待审', accepted: '已批准', rejected: '已拒绝', done: '已实现' }
        var priorityLabels = { low: '低', normal: '普通', high: '高' }

        var row = '<div class="wish-row" data-wish-id="' + escAttr(w.id) + '">'
        row += '<div>'
        row += '<div class="wish-title">' + escHtml(w.title) + '</div>'
        if (w.reason) {
          row += '<div class="wish-reason">' + escHtml(w.reason) + '</div>'
        }
        row += '<div class="wish-meta">'
        row += '<span class="wish-priority ' + (w.priority || 'normal') + '">' + (priorityLabels[w.priority] || '普通') + '</span>'
        row += '<span class="wish-status ' + (w.status || 'pending') + '">' + (statusLabels[w.status] || w.status) + '</span>'
        row += '<span class="wish-time">' + relativeTime(w.createdAt || w.created_at) + '</span>'
        row += '</div>'
        if (w.comment) {
          row += '<div class="wish-comment">' + escHtml(w.comment) + '</div>'
        }
        row += '</div>'

        // Action buttons (only show relevant actions)
        row += '<div class="wish-actions">'
        if (w.status === 'pending') {
          row += '<button class="wish-btn accept" data-wish="' + escAttr(w.id) + '" data-action="accepted">批准</button>'
          row += '<button class="wish-btn reject" data-wish="' + escAttr(w.id) + '" data-action="rejected">拒绝</button>'
        }
        if (w.status === 'accepted') {
          row += '<button class="wish-btn done" data-wish="' + escAttr(w.id) + '" data-action="done">标记完成</button>'
        }
        row += '<button class="wish-btn" data-wish="' + escAttr(w.id) + '" data-action="comment">批注</button>'
        row += '</div>'

        row += '</div>'
        return row
      }).join('')
    }

    container.innerHTML = html

    // Bind filter buttons
    container.querySelectorAll('.wish-filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        wishFilter = btn.getAttribute('data-filter')
        loadWishes()
      })
    })

    // Bind action buttons
    container.querySelectorAll('.wish-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var wishId = btn.getAttribute('data-wish')
        var action = btn.getAttribute('data-action')
        if (action === 'comment') {
          promptWishComment(wishId)
        } else {
          updateWishStatus(wishId, action)
        }
      })
    })
  }

  async function updateWishStatus(wishId, status) {
    await api('/api/wishes/' + wishId, {
      method: 'PUT',
      body: JSON.stringify({ status: status })
    })
    loadWishes()
  }

  function promptWishComment(wishId) {
    var comment = prompt('批注：')
    if (comment === null) return
    api('/api/wishes/' + wishId, {
      method: 'PUT',
      body: JSON.stringify({ comment: comment })
    }).then(function () { loadWishes() })
  }

  // ============================================
  // Issues
  // ============================================

  var issueFilter = ''

  async function loadIssues() {
    var params = issueFilter ? '?status=' + issueFilter : ''
    var data = await api('/api/issues' + params)
    if (!data) {
      document.getElementById('issues-content').innerHTML =
        '<p class="empty-state">无法加载 Issues</p>'
      return
    }
    var issues = Array.isArray(data) ? data : []
    renderIssues(issues)
  }

  function renderIssues(issues) {
    var container = document.getElementById('issues-content')

    var open = issues.filter(function (i) { return i.status === 'open' }).length
    var investigating = issues.filter(function (i) { return i.status === 'investigating' }).length
    var resolved = issues.filter(function (i) { return i.status === 'resolved' }).length

    var html = '<div class="issues-header">'
    html += '<h3>Issue</h3>'
    html += '<div class="issues-stats">'
    html += '<span>开放 ' + open + '</span>'
    html += '<span>调查中 ' + investigating + '</span>'
    html += '<span>已解决 ' + resolved + '</span>'
    html += '</div></div>'

    // Filter buttons
    html += '<div class="issue-filter">'
    var filters = [
      { value: '', label: '全部' },
      { value: 'open', label: '开放' },
      { value: 'investigating', label: '调查中' },
      { value: 'resolved', label: '已解决' },
      { value: 'wontfix', label: '不修复' }
    ]
    filters.forEach(function (f) {
      html += '<button class="issue-filter-btn' + (issueFilter === f.value ? ' active' : '') + '" data-filter="' + f.value + '">' + f.label + '</button>'
    })
    html += '</div>'

    if (issues.length === 0) {
      html += '<p class="empty-state">暂无 Issue</p>'
    } else {
      // Group by status
      var statusOrder = ['open', 'investigating', 'resolved', 'wontfix']
      var statusLabels = { open: '开放', investigating: '调查中', resolved: '已解决', wontfix: '不修复' }
      var severityLabels = { low: '低', normal: '普通', high: '高', critical: '严重' }

      if (issueFilter) {
        // When filtering, don't group
        html += issues.map(function (i) { return renderIssueRow(i, statusLabels, severityLabels) }).join('')
      } else {
        statusOrder.forEach(function (status) {
          var group = issues.filter(function (i) { return i.status === status })
          if (group.length === 0) return
          html += '<div class="issue-group">'
          html += '<div class="issue-group-header">' + (statusLabels[status] || status) + ' <span class="issue-group-count">' + group.length + '</span></div>'
          html += group.map(function (i) { return renderIssueRow(i, statusLabels, severityLabels) }).join('')
          html += '</div>'
        })
      }
    }

    container.innerHTML = html

    // Bind filter buttons
    container.querySelectorAll('.issue-filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        issueFilter = btn.getAttribute('data-filter')
        loadIssues()
      })
    })

    // Bind action buttons
    container.querySelectorAll('.issue-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var issueId = btn.getAttribute('data-issue')
        var action = btn.getAttribute('data-action')
        if (action === 'resolution') {
          promptIssueResolution(issueId)
        } else {
          updateIssueStatus(issueId, action)
        }
      })
    })
  }

  function renderIssueRow(i, statusLabels, severityLabels) {
    var titleClass = 'issue-title'
    if (i.status === 'resolved') titleClass += ' resolved'
    if (i.status === 'wontfix') titleClass += ' wontfix'

    var row = '<div class="issue-row" data-issue-id="' + escAttr(i.id) + '">'
    row += '<div>'
    row += '<div class="' + titleClass + '">' + escHtml(i.title) + '</div>'
    if (i.description) {
      row += '<div class="issue-desc">' + escHtml(i.description) + '</div>'
    }
    row += '<div class="issue-meta">'
    row += '<span class="issue-severity ' + (i.severity || 'normal') + '">' + (severityLabels[i.severity] || '普通') + '</span>'
    row += '<span class="issue-status ' + (i.status || 'open') + '">' + (statusLabels[i.status] || i.status) + '</span>'
    row += '<span class="issue-created-by">' + escHtml(i.created_by || 'xiaoxi') + '</span>'
    row += '<span class="issue-time">' + relativeTime(i.created_at) + '</span>'
    row += '</div>'
    if (i.resolution) {
      row += '<div class="issue-resolution">' + escHtml(i.resolution) + '</div>'
    }

    // Comments
    var comments = []
    try { comments = JSON.parse(i.comments || '[]') } catch {}
    if (comments.length > 0) {
      row += '<div class="issue-comments">'
      comments.forEach(function (c) {
        var time = c.created_at ? formatDate(c.created_at) : ''
        row += '<div class="issue-comment">'
        row += '<span class="comment-author">' + escHtml(c.author || '?') + '</span>'
        row += '<span class="comment-time">' + escHtml(time) + '</span>'
        row += '<div class="comment-content">' + escHtml(c.content || '') + '</div>'
        row += '</div>'
      })
      row += '</div>'
    }
    row += '</div>'

    // Action buttons
    row += '<div class="issue-actions">'
    if (i.status === 'open') {
      row += '<button class="issue-btn investigate" data-issue="' + escAttr(i.id) + '" data-action="investigating">调查</button>'
      row += '<button class="issue-btn resolve" data-issue="' + escAttr(i.id) + '" data-action="resolved">解决</button>'
      row += '<button class="issue-btn wontfix" data-issue="' + escAttr(i.id) + '" data-action="wontfix">不修复</button>'
    }
    if (i.status === 'investigating') {
      row += '<button class="issue-btn resolve" data-issue="' + escAttr(i.id) + '" data-action="resolved">解决</button>'
      row += '<button class="issue-btn wontfix" data-issue="' + escAttr(i.id) + '" data-action="wontfix">不修复</button>'
    }
    if (i.status === 'resolved' || i.status === 'wontfix') {
      row += '<button class="issue-btn" data-issue="' + escAttr(i.id) + '" data-action="open">重新打开</button>'
    }
    row += '<button class="issue-btn" data-issue="' + escAttr(i.id) + '" data-action="resolution">写解决方案</button>'
    row += '</div>'

    row += '</div>'
    return row
  }

  async function updateIssueStatus(issueId, status) {
    await api('/api/issues/' + issueId, {
      method: 'PUT',
      body: JSON.stringify({ status: status })
    })
    loadIssues()
  }

  function promptIssueResolution(issueId) {
    var resolution = prompt('解决方案/关闭原因：')
    if (resolution === null) return
    api('/api/issues/' + issueId, {
      method: 'PUT',
      body: JSON.stringify({ resolution: resolution })
    }).then(function () { loadIssues() })
  }

  // ============================================
  // Personas
  // ============================================

  async function loadPersonas() {
    var data = await api('/api/personas')
    if (!data) {
      document.getElementById('persona-content').innerHTML =
        '<p class="empty-state">无法加载 Persona 数据</p>'
      return
    }
    var personas = Array.isArray(data) ? data : []
    if (personas.length === 0) {
      document.getElementById('persona-content').innerHTML =
        '<p class="empty-state">暂无 Persona</p>'
      return
    }

    var html = '<div class="persona-header"><h3>Persona Pack</h3>'
    html += '<div class="persona-count">' + personas.length + ' 个人格</div></div>'

    html += '<div class="persona-grid">'
    personas.forEach(function (p) {
      var isMain = p.role === 'main'
      html += '<div class="persona-card">'

      // Header
      html += '<div class="persona-card-header">'
      html += '<div class="persona-name">' + escHtml(p.name || '-') + '</div>'
      if (isMain) {
        html += '<span class="persona-badge main">主人格</span>'
      }
      html += '</div>'

      // Description
      html += '<div class="persona-desc">' + escHtml(p.description || '') + '</div>'

      // Tags
      if (p.tags && p.tags.length > 0) {
        html += '<div class="persona-tags">'
        p.tags.forEach(function (t) {
          html += '<span class="persona-tag">' + escHtml(t) + '</span>'
        })
        html += '</div>'
      }

      // MCP tools whitelist
      var mcpTools = (p.mcp && p.mcp.tools) || []
      var personaKey = p.key || p.name  // 目录名
      html += '<div class="persona-section">'
      html += '<div class="persona-section-label">MCP 工具 '
      if (!isMain) {
        html += '<button class="edit-btn" data-persona="' + escAttr(personaKey) + '" data-field="mcp-tools">编辑</button>'
      }
      html += '</div>'
      html += '<div class="persona-tools" id="mcp-tools-' + escAttr(personaKey) + '">'
      if (mcpTools.length > 0) {
        mcpTools.forEach(function (t) {
          html += '<span class="persona-tool">' + escHtml(t) + '</span>'
        })
      } else {
        html += '<span class="persona-tool empty">无</span>'
      }
      html += '</div>'
      // 编辑区域（默认隐藏）
      html += '<div class="persona-edit-area" id="edit-mcp-tools-' + escAttr(personaKey) + '" style="display:none">'
      html += '<input type="text" class="persona-edit-input" value="' + escAttr(mcpTools.join(', ')) + '" placeholder="逗号分隔，如 symbiont_*, feishu_*">'
      html += '<div class="persona-edit-actions">'
      html += '<button class="save-btn" data-persona="' + escAttr(personaKey) + '" data-field="mcp-tools">保存</button>'
      html += '<button class="cancel-btn" data-persona="' + escAttr(personaKey) + '" data-field="mcp-tools">取消</button>'
      html += '</div></div>'
      html += '</div>'

      // Skills whitelist
      var skillsList = (p.skills && p.skills.include) || []
      html += '<div class="persona-section">'
      html += '<div class="persona-section-label">Skills '
      if (!isMain) {
        html += '<button class="edit-btn" data-persona="' + escAttr(personaKey) + '" data-field="skills">编辑</button>'
      }
      html += '</div>'
      html += '<div class="persona-tools" id="skills-' + escAttr(personaKey) + '">'
      if (skillsList.length > 0) {
        skillsList.forEach(function (s) {
          html += '<span class="persona-tool">' + escHtml(s) + '</span>'
        })
      } else {
        html += '<span class="persona-tool empty">无</span>'
      }
      html += '</div>'
      // 编辑区域（默认隐藏）
      html += '<div class="persona-edit-area" id="edit-skills-' + escAttr(personaKey) + '" style="display:none">'
      html += '<input type="text" class="persona-edit-input" value="' + escAttr(skillsList.join(', ')) + '" placeholder="逗号分隔，如 code-review, deploy">'
      html += '<div class="persona-edit-actions">'
      html += '<button class="save-btn" data-persona="' + escAttr(personaKey) + '" data-field="skills">保存</button>'
      html += '<button class="cancel-btn" data-persona="' + escAttr(personaKey) + '" data-field="skills">取消</button>'
      html += '</div></div>'
      html += '</div>'

      html += '</div>' // persona-card
    })
    html += '</div>' // persona-grid

    document.getElementById('persona-content').innerHTML = html

    // 绑定编辑/保存/取消按钮
    document.querySelectorAll('.edit-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var persona = btn.getAttribute('data-persona')
        var field = btn.getAttribute('data-field')
        var editArea = document.getElementById('edit-' + field + '-' + persona)
        var toolsArea = document.getElementById(field + '-' + persona)
        if (editArea) editArea.style.display = 'block'
        if (toolsArea) toolsArea.style.display = 'none'
      })
    })

    document.querySelectorAll('.cancel-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var persona = btn.getAttribute('data-persona')
        var field = btn.getAttribute('data-field')
        var editArea = document.getElementById('edit-' + field + '-' + persona)
        var toolsArea = document.getElementById(field + '-' + persona)
        if (editArea) editArea.style.display = 'none'
        if (toolsArea) toolsArea.style.display = ''
      })
    })

    document.querySelectorAll('.save-btn').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var persona = btn.getAttribute('data-persona')
        var field = btn.getAttribute('data-field')
        var editArea = document.getElementById('edit-' + field + '-' + persona)
        if (!editArea) return
        var input = editArea.querySelector('.persona-edit-input')
        var rawValue = input ? input.value.trim() : ''
        var values = rawValue ? rawValue.split(',').map(function (s) { return s.trim() }).filter(Boolean) : []

        var apiField = field === 'mcp-tools' ? 'mcp-tools' : 'skills'
        try {
          var result = await api('/api/personas/' + encodeURIComponent(persona) + '/' + apiField, {
            method: 'PUT',
            body: JSON.stringify({ values: values })
          })
          if (result) {
            loadPersonas() // 重新加载
          } else {
            alert('保存失败')
          }
        } catch (e) {
          alert('保存失败: ' + e.message)
        }
      })
    })
  }

  // ============================================
  // MCP Status
  // ============================================

  async function loadMcpStatus() {
    var data = await api('/api/mcp-status')
    if (!data) {
      document.getElementById('mcp-content').innerHTML =
        '<p class="empty-state">无法加载 MCP 状态</p>'
      return
    }

    var gw = data.gateway
    var backends = data.backends || []

    var html = '<div class="mcp-header"><h3>MCP Gateway</h3></div>'

    if (!gw) {
      html += '<p class="empty-state">Gateway 未启动</p>'
    } else {
      // Gateway overview
      html += '<div class="mcp-gateway-info">'
      html += '<div class="overview-row" style="border-top:none">'
      html += metricBlock(gw.tools, '工具总数')
      html += metricBlock(gw.backends, '后端数')
      html += metricBlock(gw.sessions, '会话数')
      html += metricBlock(gw.port, '端口')
      html += '</div>'
      html += '</div>'

      // Backends
      if (backends.length > 0) {
        html += '<div class="mcp-backends">'
        html += '<h4 class="mcp-section-title">后端服务</h4>'

        backends.forEach(function (b) {
          var tools = b.tools || []
          var bid = 'mcp-backend-' + escAttr(b.name).replace(/[^a-z0-9]/gi, '-')

          html += '<div class="mcp-backend">'
          html += '<div class="mcp-backend-header" data-toggle="' + bid + '">'
          html += '<div>'
          html += '<span class="mcp-backend-name">' + escHtml(b.name) + '</span>'
          html += '<span class="mcp-backend-url">' + escHtml(b.url || '') + '</span>'
          html += '</div>'
          html += '<span class="mcp-tool-count">' + tools.length + ' 工具 &#9662;</span>'
          html += '</div>'

          // Collapsible tool list
          html += '<div class="mcp-tool-list collapsed" id="' + bid + '">'
          if (tools.length === 0) {
            html += '<div class="mcp-tool-empty">无工具</div>'
          } else {
            tools.forEach(function (t) {
              html += '<div class="mcp-tool-item">' + escHtml(t) + '</div>'
            })
          }
          html += '</div>'

          html += '</div>' // mcp-backend
        })

        html += '</div>' // mcp-backends
      }
    }

    document.getElementById('mcp-content').innerHTML = html

    // Bind toggle events
    document.querySelectorAll('.mcp-backend-header[data-toggle]').forEach(function (header) {
      header.addEventListener('click', function () {
        var targetId = header.getAttribute('data-toggle')
        var target = document.getElementById(targetId)
        if (target) target.classList.toggle('collapsed')
      })
    })
  }

  // ============================================
  // Skills
  // ============================================

  async function loadSkills() {
    var data = await api('/api/skills')
    if (!data) {
      document.getElementById('skills-content').innerHTML =
        '<p class="empty-state">无法加载 Skills 数据</p>'
      return
    }
    var skills = Array.isArray(data) ? data : []

    var html = '<div class="skills-header"><h3>Skill 库</h3>'
    html += '<div class="skills-count">' + skills.length + ' 个 skill</div></div>'

    if (skills.length === 0) {
      html += '<p class="empty-state">暂无 skill（skills/ 目录为空）</p>'
    } else {
      html += '<div class="skills-list">'
      skills.forEach(function (s) {
        html += '<div class="skill-row">'
        html += '<div class="skill-name">' + escHtml(s.name) + '</div>'
        html += '<div class="skill-meta">'
        if (s.hasSkillMd) {
          html += '<span class="skill-badge has-doc">SKILL.md</span>'
        } else {
          html += '<span class="skill-badge no-doc">无文档</span>'
        }
        html += '</div>'
        html += '</div>'
      })
      html += '</div>'
    }

    document.getElementById('skills-content').innerHTML = html
  }

  // ============================================
  // Releases
  // ============================================

  async function loadReleases() {
    var data = await api('/api/releases?limit=50')
    if (!data) {
      document.getElementById('releases-content').innerHTML =
        '<p class="empty-state">无法加载更新日志</p>'
      return
    }
    var releases = Array.isArray(data) ? data : []
    renderReleases(releases)
  }

  function renderReleases(releases) {
    var container = document.getElementById('releases-content')

    var html = '<div class="releases-header">'
    html += '<h3>版本更新</h3>'
    html += '<div class="releases-count">' + releases.length + ' 个版本</div>'
    html += '</div>'

    if (releases.length === 0) {
      html += '<p class="empty-state">暂无更新记录</p>'
      container.innerHTML = html
      return
    }

    html += '<div class="releases-timeline">'

    releases.forEach(function (r, idx) {
      var commits = []
      try { commits = JSON.parse(r.commits) } catch { commits = [] }
      if (!Array.isArray(commits)) commits = []

      var deployedAt = r.deployed_at || r.deployedAt || ''
      var dateStr = '-'
      var timeStr = ''
      if (deployedAt) {
        var d = new Date(deployedAt)
        dateStr = d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-')
        timeStr = d.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
      }

      var isFirst = idx === 0

      html += '<div class="release-node' + (isFirst ? ' latest' : '') + '">'

      // 时间线左侧
      html += '<div class="release-timeline-col">'
      html += '<div class="release-dot' + (isFirst ? ' latest' : '') + '"></div>'
      if (idx < releases.length - 1) {
        html += '<div class="release-line"></div>'
      }
      html += '</div>'

      // 右侧内容
      html += '<div class="release-content">'
      html += '<div class="release-version-line">'
      html += '<span class="release-version">' + escHtml(r.version || '-') + '</span>'
      if (r.git_hash || r.gitHash) {
        html += '<span class="release-hash">' + escHtml((r.git_hash || r.gitHash || '').slice(0, 8)) + '</span>'
      }
      html += '</div>'
      html += '<div class="release-date">' + escHtml(dateStr) + ' ' + escHtml(timeStr) + '</div>'

      if (commits.length > 0) {
        html += '<ul class="release-commits">'
        commits.forEach(function (c) {
          html += '<li class="release-commit">' + escHtml(c) + '</li>'
        })
        html += '</ul>'
      } else {
        html += '<div class="release-no-commits">无变更记录</div>'
      }

      html += '</div>'  // release-content
      html += '</div>'  // release-node
    })

    html += '</div>'  // releases-timeline

    container.innerHTML = html
  }

  // ============================================
  // Utilities
  // ============================================

  function escHtml(s) {
    if (typeof s !== 'string') s = String(s == null ? '' : s)
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function escAttr(s) {
    return escHtml(s)
  }

  // ============================================
  // Init
  // ============================================

  switchView(getHash())

  // SSE replaces polling
  connectSSE()

})()
