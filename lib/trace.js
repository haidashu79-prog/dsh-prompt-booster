// 在插件里挂一个文件打点器（临时调试用），把每次 pre-step 的判定写到 /tmp/pbwork/trace.log
import { appendFileSync } from 'node:fs'

const LOG = '/tmp/pbwork/trace.log'
const stamp = () => new Date().toISOString()

export function trace(tag, data) {
  try {
    appendFileSync(LOG, `${stamp()} ${tag} ${typeof data === 'string' ? data : JSON.stringify(data)}\n`)
  } catch {
    /* ignore */
  }
}
