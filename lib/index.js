/**
 * dsh-prompt-booster v0.4.0 — 提示词自动补全（v0.4.0 新增：补全稿对用户可见、并自动标注重点）
 *
 * 目标用户：不会写提示词的人。他们输入不完整、措辞含糊、缺上下文。
 * 本插件在每一条用户输入进入模型之前，先让一次小模型调用"读懂意图 + 补全"，
 * 然后把补全稿以一条 plugin 消息追加在原话之后，模型拿到的就是完整提示词。
 *
 * v0.2.0 在 v0.1 基础上吸收了市场同类插件的长处：
 *  - 每条新输入都触发（不再只看 turn 首步），按消息指纹去重，同一条消息只补一次
 *  - 三档强度 low/high/max（参考 saul-dsh/dsh-prompt-enhancer），max 档会标注假设
 *  - 参考最近会话上下文（参考 dsh-prompt-rewriter / dsh-prompt-clarifier），
 *    用上一轮对话补全"他"、"那个"之类的指代
 *  - 意图不明时不瞎猜：给出待确认点 + 关键假设，并指示助手优先按最合理解释执行、
 *    必要时用自然语言反问一句（参考 dsh-prompt-clarifier 的提问卡片思路）
 *  - 原话优先、可审计：不改动用户原消息，只在后面追加补全块，冲突以原话为准
 *  - fail-open：补全失败/超时一律放行原话，不阻塞对话
 *  - 斜杠命令、带附件、超长、超短的消息跳过
 *
 * v0.4.0：补全稿默认对用户可见（showRewrite 默认 true），并额外提取"重点标注"
 *  （核心要求列表），让小白一眼看清系统理解对了没有。
 */

import { BlockAssembler, createUserMessage, deepFreeze } from './llm-compat.js'
import { trace } from './trace.js'

const PLUGIN = 'dsh-prompt-booster'
const VERSION = '0.4.0'
const TIMEOUT_MS = 20000

export const name = PLUGIN
export const inject = ['llm']

// ───────────────────────────── 配置 ─────────────────────────────

const LEVELS = ['low', 'high', 'max']

function parseConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const num = (v, d, min, max) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return d
    return Math.min(max, Math.max(min, n))
  }
  const level = LEVELS.includes(cfg.level) ? cfg.level : 'high'
  return {
    enabled: cfg.enabled !== false,
    level,
    showRewrite: cfg.showRewrite !== false,
    contextTurns: num(cfg.contextTurns, 2, 0, 6),
    contextChars: num(cfg.contextChars, 1200, 0, 8000),
    minChars: num(cfg.minChars, 4, 0, 1000),
    skipIfContains: Array.isArray(cfg.skipIfContains) ? cfg.skipIfContains.map(String).filter(Boolean) : [],
    provider: typeof cfg.provider === 'string' ? cfg.provider.trim() : '',
    model: typeof cfg.model === 'string' ? cfg.model.trim() : '',
    maxInputChars: num(cfg.maxInputChars, 4000, 200, 20000),
    maxOutputTokens: num(cfg.maxOutputTokens, 900, 100, 4000),
    timeoutMs: num(cfg.timeoutMs, TIMEOUT_MS, 1000, 120000),
    failOpen: cfg.failOpen !== false,
    announce: cfg.announce === true,
  }
}

const LEVEL_RULES = {
  low: [
    '强度=低：只补最必要的缺口，尽量不动原话措辞。',
    '长度控制在原话的 1.0~1.5 倍。',
  ],
  high: [
    '强度=中：补齐四类缺失信息，措辞可整理，但不扩写、不加用户没提的需求。',
    '长度控制在原话的 1.3~2.5 倍。',
  ],
  max: [
    '强度=高：可以补充必要的执行细节（步骤、检查点、验收标准），但每一条补充都必须是"用户这句话本来要实现它就必须有"的。',
    '凡是用户没明确、你按常理补上的内容，就近用 (假设: …) 标出来。',
    '长度控制在原话的 2~3.5 倍，不要超过 600 字。',
  ],
}

function buildSystemPrompt(level) {
  return [
    '你是一个"提示词补全器"。用户输入往往不完整、措辞含糊、缺上下文，直接交给模型会答偏。',
    '你的任务：读懂他真正想干什么，把这句话补成一条信息完整、模型可以直接执行的提示词。',
    '',
    '规则：',
    '1. 严守原意。不换任务、不替他做重大决定、不添加他没要的功能。',
    '2. 只补四类缺口：目标（要达成什么结果）、输入（基于什么素材/对象）、约束（范围/风格/不要什么）、交付（要什么形式、给谁、什么标准）。',
    '3. 用户已经说清的，原样保留，不换词、不扩写、不重复强调。',
    '4. 用用户原来的语言。',
    '5. 如果提供了"最近对话"，用它来消除指代歧义（他/它/那个/上面这种），但不要把上下文的旧要求硬塞进这一次。',
    '6. 如果原话已经足够清楚，正文就接近原话，不要为了"显得有用"而注水。',
    '7. 输出"重点:"小节：用 1~4 条短句列出你锁定的核心要求（给谁/什么形式/什么标准/什么范围），让用户一眼看清你理解对了没有。每条一行，可加 "- " 前缀。',
    ...LEVEL_RULES[level],
    '',
    '输出格式（严格遵守，只输出下面三段，不要解释、不要代码块围栏）：',
    '第一行：以"待确认:"开头，写出 1~3 个真正影响结果、但用户没说清的点；确实没有就写"待确认: 无"。',
    '第二行起：以"提示词:"开头，空一行后写补全后的完整提示词。',
    '提示词写完后另起一段：以"重点:"开头，空一行后逐条列出核心要求，每条一行。',
  ].join('\n')
}

function buildUserFrame(text, context) {
  const parts = []
  if (context) {
    parts.push('【最近对话（仅供消除指代，不要照搬旧要求）】', context, '')
  }
  parts.push('【用户这一次的原始输入】', text, '')
  parts.push('请输出：第一行"待确认: …"，第二行起"提示词: …"。')
  return parts.join('\n')
}

// ───────────────────────────── 工具函数 ─────────────────────────────

function serviceOf(ctx, key) {
  try {
    return ctx?.[key] ?? null
  } catch {
    return null
  }
}

function replyServiceOf(ctx) {
  for (const key of ['messageReply', 'reply', 'chatReply']) {
    const s = serviceOf(ctx, key)
    if (s && typeof s === 'object') return { service: s, key }
  }
  return null
}

/** 提取一条消息里的纯文本；插件自己注入的消息不算用户输入。 */
function textOf(message) {
  if (!message) return ''
  const source = message.source
  if (source && typeof source === 'object' && source.kind === 'plugin') return ''
  const content = Array.isArray(message.content) ? message.content : []
  let out = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out.trim()
}

function userTextOf(message) {
  if (!message || message.role !== 'user') return ''
  return textOf(message)
}

function hasAttachment(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content.some((b) => b && b.type !== 'text')
}

function fingerprint(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${text.length}:${h.toString(36)}`
}

function shouldSkip(text, state, cfg) {
  if (!text) return 'empty'
  const chars = [...text].length
  if (chars < cfg.minChars) return 'too-short'
  if (chars > cfg.maxInputChars) return 'too-long'
  // 斜杠命令是 DSH 自己的指令，不补全
  if (text.startsWith('/')) return 'slash-command'
  for (const marker of cfg.skipIfContains) {
    if (marker && text.includes(marker)) return 'contains-skip-marker'
  }
  if (state.seen.has(fingerprint(text))) return 'already-seen'
  return ''
}

/** 从最近消息里拼一段"上一轮用户说 / 助手答"的摘要。 */
function buildRecentContext(messages, cfg) {
  if (cfg.contextTurns <= 0 || cfg.contextChars <= 0) return ''
  const picked = []
  for (let i = messages.length - 1; i >= 0 && picked.length < cfg.contextTurns * 2; i -= 1) {
    const m = messages[i]
    if (!m) continue
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const t = textOf(m)
    if (!t) continue
    picked.push(`${m.role === 'user' ? '用户' : '助手'}：${t}`)
  }
  picked.reverse()
  if (!picked.length) return ''
  let joined = picked.join('\n')
  if (joined.length > cfg.contextChars) joined = `${joined.slice(0, cfg.contextChars)}…`
  return joined
}

/** 解析模型输出：待确认点 + 补全稿 + 重点标注。 */
function parseRewrite(raw) {
  const text = String(raw ?? '').replace(/```[a-z]*\n?/gi, '').trim()
  if (!text) return null
  const lines = text.split('\n')
  // 分节状态机：识别三种分节标题（待确认 / 提示词 / 重点），标题之后的内容归入该节，直到下一个标题。
  let section = 'body'
  const buckets = { open: [], body: [], points: [] }
  const HEAD = /^(待确认|待补充|需要确认|确认点|missing|clarify|提示词|补全后|prompt|重点|关键点|核心要求|要点)\s*[:：]\s*(.*)$/i
  for (const line of lines) {
    const m = line.trim().match(HEAD)
    if (m) {
      const key = m[1].toLowerCase()
      const inline = m[2].trim()
      if (/^(待确认|待补充|需要确认|确认点|missing|clarify)$/.test(key)) {
        section = 'open'
      } else if (/^(提示词|补全后|prompt)$/.test(key)) {
        section = 'body'
      } else {
        section = 'points'
      }
      if (inline) buckets[section].push(inline)
      continue
    }
    buckets[section].push(line)
  }
  let open = buckets.open.join(' ').trim()
  let body = buckets.body.join('\n').trim()
  let points = buckets.points.join('\n').trim()
  if (/^(无|none|no)$/i.test(open)) open = ''
  if (!body) body = text
  return { open, body, points }
}

function withTimeout(signal, ms) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('prompt-booster: timeout')), ms)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    },
  }
}

// ───────────────────────────── 主逻辑 ─────────────────────────────

export function apply(ctx, config) {
  const cfg = parseConfig(config)
  if (!cfg.enabled) {
    ctx.logger?.info?.('[prompt-booster] disabled; skipping mount')
    return
  }

  const stats = { calls: 0, rewrites: 0, failures: 0, skipped: 0, lastError: null, lastReason: null, level: cfg.level }

  const routeSource = { last: 'none' }

  /**
   * 找出"这次补全该用哪个 provider/model"。
   * 依据（按可信度排序）：
   *   1. 配置里写死的 provider+model；
   *   2. 这个会话上一次真正发请求时解析出的路由：session.requestContext() / requestHeader()；
   *   3. agent 自身的 options.provider/model。
   * 说明：agent/request 事件的 payload 里没有 agent，不能用 WeakMap 去记（v0.2.0 的 bug）。
   */
  function resolveRoute(agent) {
    if (cfg.provider && cfg.model) {
      routeSource.last = 'config'
      return { provider: cfg.provider, model: cfg.model }
    }
    const session = agent?.session
    if (session && typeof session === 'object') {
      try {
        const rc = typeof session.requestContext === 'function' ? session.requestContext() : null
        if (rc && rc.provider && rc.model) {
          routeSource.last = 'session.requestContext'
          return { provider: rc.provider, model: rc.model }
        }
      } catch {
        /* ignore */
      }
      try {
        const header = typeof session.requestHeader === 'function' ? session.requestHeader() : null
        const conf = header && typeof header === 'object' ? header.config : null
        if (conf && conf.provider && conf.model) {
          routeSource.last = 'session.requestHeader'
          return { provider: conf.provider, model: conf.model }
        }
      } catch {
        /* ignore */
      }
    }
    const opts = agent?.options
    if (opts && opts.provider && opts.model) {
      routeSource.last = 'agent.options'
      return { provider: opts.provider, model: opts.model }
    }
    routeSource.last = 'none'
    return null
  }

  async function rewrite(text, context, agent, signal) {
    const llm = serviceOf(ctx, 'llm')
    if (!llm || typeof llm.stream !== 'function') throw new Error('llm service unavailable')

    const route = resolveRoute(agent)
    if (!route) throw new Error('no route: no provider/model from config, session.requestContext(), or agent.options')

    const guard = withTimeout(signal, cfg.timeoutMs)
    try {
      const options = deepFreeze({
        provider: route.provider,
        model: route.model,
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: buildUserFrame(text, context) }],
            source: { kind: `plugin:${PLUGIN}` },
          }),
        ],
        system: buildSystemPrompt(cfg.level),
        maxTokens: cfg.maxOutputTokens,
        sessionId: agent?.session?.id,
        purpose: 'prompt-booster',
        signal: guard.signal,
      })

      const assembler = new BlockAssembler()
      for await (const chunk of llm.stream(options)) {
        guard.signal.throwIfAborted()
        if (!chunk || typeof chunk !== 'object') continue
        // BlockAssembler 的 block-end 要求 chunk.block.type、block-start 要求 blockType；
        // 流式文本只靠 text-delta 累积即可闭合组装，所以这里只认三种 chunk，其余一律忽略。
        if (chunk.type !== 'text-delta' && chunk.type !== 'finish' && chunk.type !== 'usage') continue
        assembler.push(chunk)
      }
      guard.signal.throwIfAborted()
      const finish = assembler.finish
      const finishReason = finish && typeof finish === 'object' ? finish.kind : finish
      if (finishReason && finishReason !== 'stop' && finishReason !== 'end-turn' && finishReason !== 'max-tokens') {
        throw new Error(`model finished with ${finishReason}`)
      }
      const blocks = assembler.blocks()
      const raw = blocks
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      return parseRewrite(raw)
    } finally {
      guard.dispose()
    }
  }

  function buildInjection(original, rewritten) {
    const lines = [
      '[提示词补全] 下面是系统对用户上一条原话的补全稿：意图与原文一致，只是补上了原文省略的背景/目标/约束/交付形式。',
      '执行规则：按补全稿理解需求；补全稿与用户原话冲突时，以用户原话为准。',
      '',
      '## 用户原话',
      original,
      '',
      '## 补全后的提示词',
      rewritten.body,
      '',
    ]
    if (rewritten.points) {
      lines.push(
        '## 重点标注',
        ...rewritten.points.split('\n').map((p) => `► 重点：${p}`),
        '',
      )
    }
    if (rewritten.open) {
      lines.push(
        '## 待确认',
        rewritten.open,
        '',
        '处理方式：不要因为待确认而停下来追问，先按最合理的解释把事做完；做完后用一两句话说明你采用了什么假设，并只在结果会明显不同时补一句追问。',
      )
    }
    return lines.join('\n')
  }

  async function announce(agent, rewritten) {
    if (!cfg.showRewrite) return
    const hit = replyServiceOf(ctx)
    if (!hit) return
    let text = `已补全提示词：\n\n${rewritten.body}`
    if (rewritten.points) {
      text += `\n\n重点标注：\n${rewritten.points
        .split('\n')
        .map((p) => `► ${p}`)
        .join('\n')}`
    }
    if (rewritten.open) text += `\n\n待确认：${rewritten.open}`
    try {
      await hit.service.push?.(text, { sessionId: agent?.session?.id, source: PLUGIN })
    } catch (err) {
      ctx.logger?.debug?.(`[prompt-booster] announce failed: ${String(err?.message ?? err)}`)
    }
  }

  /** 每个 agent 的去重表：同一条用户消息只补全一次。 */
  const FALLBACK_STATE_KEY = {}
  const states = new WeakMap()
  function stateOf(agent) {
    let s = states.get(agent)
    if (!s) {
      s = { seen: new Set(), order: [] }
      states.set(agent, s)
    }
    return s
  }
  function remember(state, text) {
    const fp = fingerprint(text)
    if (state.seen.has(fp)) return
    state.seen.add(fp)
    state.order.push(fp)
    if (state.order.length > 200) {
      const old = state.order.shift()
      state.seen.delete(old)
    }
  }

  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      trace('pre-step.enter', { step: payload?.step, turn: payload?.turn, hasAgent: Boolean(payload?.agent) })
      const decision = await next()
      if (!decision || decision.kind === 'reject') return decision
      if (payload.signal?.aborted) return decision

      const messages = Array.isArray(decision.messages) ? decision.messages : []
      // 不能直接读 ctx.agent：本插件 inject 只有 ['llm']，cordis 代理会对未声明服务
      // 抛 `cannot get property "agent" without inject`，导致整轮 agent 直接失败。
      // 事件 payload 自带 agent，优先用它；实在要回读 ctx 时也必须 try/catch 兜底。
      let agent = payload?.agent ?? null
      if (!agent) {
        try {
          agent = ctx.agent ?? null
        } catch {
          agent = null
        }
      }
      const state = stateOf(agent ?? FALLBACK_STATE_KEY)

      // 找最近一条"人类输入"的消息：每一步都检查，但靠指纹去重保证只补一次
      let latest = null
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const t = userTextOf(messages[i])
        if (t) {
          latest = { message: messages[i], text: t }
          break
        }
      }
      if (!latest) {
        trace('pre-step.no-user-message', { count: messages.length })
        return decision
      }
      if (hasAttachment(latest.message)) {
        stats.skipped += 1
        stats.lastReason = 'has-attachment'
        return decision
      }

      const skip = shouldSkip(latest.text, state, cfg)
      if (skip) {
        trace('pre-step.skip', { reason: skip, text: latest.text.slice(0, 60) })
        if (skip !== 'already-seen') {
          stats.skipped += 1
          stats.lastReason = skip
        }
        return decision
      }
      remember(state, latest.text)

      const index = messages.lastIndexOf(latest.message)
      const ctxMessages = index > 0 ? messages.slice(0, index) : []
      const recent = buildRecentContext(ctxMessages, cfg)

      stats.calls += 1
      let rewritten = null
      try {
        rewritten = await rewrite(latest.text, recent, agent, payload.signal)
      } catch (err) {
        stats.failures += 1
        stats.lastError = String(err?.message ?? err)
        trace('pre-step.rewrite-failed', stats.lastError)
        ctx.logger?.warn?.(`[prompt-booster] rewrite failed (fail-open): ${stats.lastError}`)
        if (!cfg.failOpen) throw err
        return decision
      }
      if (!rewritten) {
        stats.lastReason = 'empty-rewrite'
        return decision
      }

      stats.rewrites += 1
      stats.lastReason = 'ok'
      trace('pre-step.inject', { level: cfg.level, route: routeSource.last, chars: [...rewritten.body].length })
      ctx.logger?.info?.(
        `[prompt-booster] L${payload.step} rewrote ${[...latest.text].length} chars -> ${[...rewritten.body].length} chars (level=${cfg.level}, route=${routeSource.last})`,
      )

      void announce(agent, rewritten)

      return {
        ...decision,
        messages: [
          ...messages,
          createUserMessage({
            content: [{ type: 'text', text: buildInjection(latest.text, rewritten) }],
            source: {
              kind: `plugin:${PLUGIN}`,
              form: 'snapshot',
              sections: [
                { name: '补全后的提示词', text: rewritten.body },
                ...(rewritten.points ? [{ name: '重点标注', text: rewritten.points }] : []),
                ...(rewritten.open ? [{ name: '待确认', text: rewritten.open }] : []),
              ],
            },
          }),
        ],
      }
    },
    { prepend: true },
  )

  ctx.provide(
    'promptBooster',
    {
      version: VERSION,
      getConfig: () => ({ ...cfg }),
      getStats: () => ({ ...stats, routeSource: routeSource.last }),
      setEnabled: (on) => {
        cfg.enabled = Boolean(on)
        return cfg.enabled
      },
      setLevel: (lv) => {
        if (LEVELS.includes(lv)) cfg.level = lv
        return cfg.level
      },
    },
    'prompt-booster service',
  )

  ctx.logger?.info?.(`[prompt-booster] v${VERSION} mounted (auto prompt completion on every user message, level=${cfg.level}, showRewrite=${cfg.showRewrite})`)

  trace('apply.mounted', { version: VERSION, level: cfg.level })
}

export { parseRewrite }

export default { name, inject, apply }
