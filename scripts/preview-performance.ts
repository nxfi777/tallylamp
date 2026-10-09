/** Local-only disposable dashboard/extension lab. Never connects to an existing data directory. */
import express from 'express';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { startTestServer } from '../tests/helpers.js';
import { adminPrincipal, createAgent } from '../src/auth.js';

const ctx = await startTestServer();
for (let i = 0; i < 30; i++) (await ctx.browsers.create({ principal: adminPrincipal(), via: 'dashboard', name: `Performance browser ${String(i + 1).padStart(2, '0')}`, metadata: { project: i % 2 ? 'Research' : 'Finance', purpose: 'Disposable performance fixture' } }));
for (let i = 0; i < 5; i++) createAgent({ name: `Performance agent ${i + 1}` });
ctx.app.use('/extension', express.static(path.resolve('extension')));
ctx.app.get('/perf/login', (_req, res) => { res.setHeader('Set-Cookie', `${ctx.cookie}; Path=/; HttpOnly; SameSite=Strict`); res.redirect('/'); });
ctx.app.get('/perf/fixture', (_req, res) => res.json({ browsers: ctx.browsers.list().map(b => ({ id: b.id, name: b.name })) }));
writeFileSync('/tmp/tallylamp-performance-lab.json', JSON.stringify({ url: ctx.url }));
console.log(`Disposable lab: ${ctx.url}/perf/login`);
console.log(`Extension states: ${ctx.url}/extension/panel.html?demo=ready`);
let closing = false;
const close = async () => { if (closing) return; closing = true; await ctx.close(); process.exit(0); };
process.on('SIGINT', close); process.on('SIGTERM', close);
