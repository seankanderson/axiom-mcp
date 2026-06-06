#!/usr/bin/env node
// Builds the Desktop Extension (.mcpb): bundles the stdio server into a single
// file with esbuild, stages it next to the manifest, and runs `mcpb pack`.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stage = join(root, 'mcpb-build')
const outDir = join(root, 'dist-mcpb')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Clean staging.
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'server'), { recursive: true })
mkdirSync(outDir, { recursive: true })

// 1. Bundle the stdio entry point + all deps into one ESM file.
await build({
  entryPoints: [join(root, 'src', 'server.ts')],
  outfile: join(stage, 'server', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Node built-ins resolve natively; everything else is bundled.
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
})

// 2. Stage the manifest (and icon, if present).
copyFileSync(join(root, 'manifest.json'), join(stage, 'manifest.json'))
if (existsSync(join(root, 'icon.png'))) {
  copyFileSync(join(root, 'icon.png'), join(stage, 'icon.png'))
}

// 3. Pack with the official CLI.
const outFile = join(outDir, `axiom-mcp-${pkg.version}.mcpb`)
execFileSync('npx', ['--yes', '@anthropic-ai/mcpb', 'pack', stage, outFile], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

console.log(`\nBuilt ${outFile}`)
