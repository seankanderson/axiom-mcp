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
const notifications = []

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
        } else if (msg.method?.startsWith('notifications/')) {
            notifications.push(msg)
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

function fmt(obj) { return JSON.stringify(obj, null, 2) }

try {
    const init = await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { sampling: {}, roots: { listChanged: false } },
        clientInfo: { name: 'discover-script', version: '0.0.1' },
    }, 1)

    console.log('═══ initialize ═══')
    console.log('protocolVersion:', init.result?.protocolVersion)
    console.log('serverInfo:    ', fmt(init.result?.serverInfo))
    console.log('capabilities:  ', fmt(init.result?.capabilities))

    await send('notifications/initialized', {})

    // Subscribe to all logs so we see them.
    await send('logging/setLevel', { level: 'debug' }, 100)

    const tools     = await send('tools/list',                {}, 2)
    const resources = await send('resources/list',            {}, 3)
    const templates = await send('resources/templates/list',  {}, 4)
    const prompts   = await send('prompts/list',              {}, 5)

    console.log('\n═══ tools ═══')
    for (const t of tools.result?.tools ?? []) {
        const required = t.inputSchema?.required ?? []
        const props = Object.keys(t.inputSchema?.properties ?? {})
        const sig = props.map(p => required.includes(p) ? p : `${p}?`).join(', ')
        console.log(`  • ${t.name}(${sig})`)
        console.log(`      ${t.description}`)
    }

    console.log('\n═══ resources (static) ═══')
    for (const r of resources.result?.resources ?? []) {
        console.log(`  • ${r.uri}`)
        console.log(`      name: ${r.name}`)
        console.log(`      ${r.description}`)
    }

    console.log('\n═══ resource templates ═══')
    for (const r of templates.result?.resourceTemplates ?? []) {
        console.log(`  • ${r.uriTemplate}`)
        console.log(`      name: ${r.name}`)
        console.log(`      ${r.description}`)
    }

    console.log('\n═══ prompts ═══')
    for (const p of prompts.result?.prompts ?? []) {
        const argSig = (p.arguments ?? []).map(a => a.required ? a.name : `${a.name}?`).join(', ')
        console.log(`  • ${p.name}(${argSig})`)
        console.log(`      ${p.description}`)
    }

    // Drain any pending log notifications (give the server a beat).
    await new Promise(r => setTimeout(r, 100))
    if (notifications.length) {
        console.log('\n═══ notifications received ═══')
        for (const n of notifications) {
            console.log(`  • ${n.method}`, n.params ? fmt(n.params) : '')
        }
    }
} finally {
    child.kill()
}
