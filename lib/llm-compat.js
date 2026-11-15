// llm-compat.js — vendored, self-contained subset of @deepseek-ai/dsh-llm
//
// Inlined so the published plugin carries NO dependency on the host-private
// dsh-llm copy (which lives at a path only this machine has). Source:
// @deepseek-ai/dsh-llm@0.1.1-rc.2 lib/index.js (deepFreeze / message / assembler
// regions). Only standard-library APIs are used (crypto, Object, structuredClone,
// WeakSet), so this module is portable across Node versions.
//
// The plugin only ever calls:
//   - deepFreeze()        to freeze the request options object
//   - createUserMessage() to build the user-role prompt frame
//   - new BlockAssembler() + .blocks() to extract text from the LLM stream
// The private helpers (MessageId / CallId / assertNever / freezeMessage /
// createMessage) are kept so BlockAssembler.message() stays syntactically whole.

function MessageId(id) {
  return id
}

function CallId(id) {
  return id
}

function assertNever(value, context) {
  const rendered = JSON.stringify(value) ?? String(value)
  throw new Error(`unreachable variant${context ? ` in ${context}` : ''}: ${rendered}`)
}

export function deepFreeze(value) {
  const seen = new WeakSet()
  const pending = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    if (task === void 0) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      if (key === void 0) continue
      pending.push({ kind: 'property', source: node, key })
    }
  }
  return value
}

function freezeMessage(message) {
  return deepFreeze(structuredClone(message))
}

function createMessage(input) {
  return freezeMessage({ ...input, id: MessageId(crypto.randomUUID()) })
}

export function createUserMessage(input) {
  return createMessage({ ...input, role: 'user' })
}

export class BlockAssembler {
  partials = new Map()
  order = []
  _usage
  _finish
  _replayState

  push(chunk) {
    switch (chunk.type) {
      case 'block-start':
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, {
            blockType: chunk.blockType,
            text: '',
            toolCallArguments: ''
          })
        }
        return
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block) return
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
        if (partial.block) return
        partial.toolCallId = chunk.id
        if (chunk.name) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type)
        if (partial.block) return
        partial.block = chunk.block
        return
      }
      case 'usage':
        this._usage = chunk.usage
        return
      case 'finish':
        this._finish = chunk.reason
        this._replayState = chunk.replayState
        return
      default: return assertNever(chunk, 'BlockAssembler.push')
    }
  }

  ensure(index, blockType) {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = {
        blockType,
        text: '',
        toolCallArguments: ''
      }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  assemble(partial, index) {
    if (partial.block) return partial.block
    switch (partial.blockType) {
      case 'text': return { type: 'text', text: partial.text }
      case 'reasoning': return { type: 'reasoning', text: partial.text }
      case 'tool-call': return {
        type: 'tool-call',
        id: partial.toolCallId ?? CallId(`call-${index}`),
        name: partial.toolCallName ?? '',
        arguments: partial.toolCallArguments
      }
      default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`)
    }
  }

  mustGet(index) {
    const partial = this.partials.get(index)
    if (!partial) throw new Error(`BlockAssembler invariant violated: no partial for index ${index}`)
    return partial
  }

  assembled() {
    const all = this.order.map((index) => this.assemble(this.mustGet(index), index))
    const kept = this.finish.kind === 'max-tokens' ? all.map((block) => block.type !== 'tool-call') : void 0
    const blocks = kept === void 0 ? all : all.filter((_, position) => kept[position])
    const envelope = this._replayState
    if (envelope?.blocks === void 0) return { blocks, replay: envelope }
    if (envelope.blocks.length !== all.length) return { blocks, replay: void 0 }
    return {
      blocks,
      replay: kept === void 0 || blocks.length === all.length ? envelope : {
        response: envelope.response,
        blocks: envelope.blocks.filter((_, position) => kept[position])
      }
    }
  }

  blocks() {
    return this.assembled().blocks
  }

  interruptedBlocks() {
    return this.order.map((index) => {
      const partial = this.mustGet(index)
      const type = partial.block?.type ?? partial.blockType
      if (type !== 'text' && type !== 'reasoning') return void 0
      return this.assemble(partial, index)
    }).filter((block) => (block?.type === 'text' || block?.type === 'reasoning') && block.text.trim() !== '')
  }

  get usage() {
    return this._usage
  }

  get finish() {
    return this._finish ?? { kind: 'stop' }
  }

  get replayState() {
    return this.assembled().replay
  }

  message(source = { kind: 'plugin', plugin: 'dsh-llm/assembler' }) {
    return createMessage({ role: 'assistant', content: this.blocks(), source })
  }
}
