#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = resolve(here, '..', 'dist', 'server.js')

const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env },
})

let buffer = ''
const pending = new Map()

child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id != null && pending.has(msg.id)) {
            const { resolve: r } = pending.get(msg.id)
            pending.delete(msg.id)
            r(msg)
        }
    }
})

function send(method, params, id) {
    const req = id != null
        ? { jsonrpc: '2.0', id, method, params }
        : { jsonrpc: '2.0', method, params }
    child.stdin.write(JSON.stringify(req) + '\n')
    if (id == null) return Promise.resolve()
    return new Promise((resolve) => pending.set(id, { resolve }))
}

try {
    const init = await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'list-tools-script', version: '0.0.1' },
    }, 1)
    console.log('Initialized:', init.result?.serverInfo)

    await send('notifications/initialized', {})

    const list = await send('tools/list', {}, 2)
    const tools = list.result?.tools ?? []
    console.log(`\n${tools.length} tools available:\n`)
    for (const t of tools) {
        const required = t.inputSchema?.required ?? []
        const props = Object.keys(t.inputSchema?.properties ?? {})
        const sig = props
            .map(p => required.includes(p) ? p : `${p}?`)
            .join(', ')
        console.log(`  • ${t.name}(${sig})`)
        console.log(`      ${t.description}`)
    }
} finally {
    child.kill()
}
