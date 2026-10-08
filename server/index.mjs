// ST-SaveGuard — server plugin
// Watches chat files on the server and keeps a small rolling set of snapshots per chat.
// Everything here runs on the server's own disk; nothing is uploaded or downloaded by players
// unless they explicitly restore or download a snapshot.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = readJson(path.join(PLUGIN_ROOT, 'package.json'))?.version ?? '0.0.0';
const UI_FOLDER = 'ST-SaveGuard';
const UI_MARKER = '.saveguard-managed';
const TAG = '[SaveGuard]';

const cfg = {
    keep: 5,            // rolling snapshots per chat (one per round)
    keepProtected: 2,   // extra snapshots kept when a chat suddenly shrinks or is restored over
    protectDrop: 5,     // "suddenly shrinks" = this many messages gone in a single save
    orphanDays: 30,     // snapshots of deleted chats are removed after this many days
    settleMs: 800,      // wait this long after the last write before copying
    scanSeconds: 60,    // safety-net scan interval (also picks up new users)
    installUi: true,    // copy the UI extension into SillyTavern's global extensions folder
    ...readJson(path.join(PLUGIN_ROOT, 'config.json')),
};

// <stamp>_<messages>_<flag>_<hash>.jsonl.gz
// flag: a = round finished, u = last message is the user's (in progress), p = protected
const DELETED_MARK = '.deleted';   // dropped into a chat's snapshot folder when the chat file disappears
const SNAP_RE = /^(\d{8}-\d{6}-\d{3})_(\d+)_([aup])_([0-9a-f]{10})\.jsonl\.gz$/;

const watchers = new Map();   // watched dir -> FSWatcher
const warned = new Set();     // dirs we already complained about
const seen = new Map();       // chat file -> mtimeMs already handled
const timers = new Map();     // chat file -> settle timer
let queue = Promise.resolve();
let scanTimer = null;
let purgeTimer = null;
let stopped = false;

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function dataRoot() {
    return path.resolve(globalThis.DATA_ROOT ?? 'data');
}

/** Runs jobs one at a time so snapshot bookkeeping never races with itself. */
function enqueue(job) {
    const run = queue.then(job);
    queue = run.catch(error => console.error(TAG, error));
    return run;
}

/** Every user's chat folders, as { root, kind, backups }. */
function listTargets() {
    const root = dataRoot();
    const targets = [];
    let entries = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return targets;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        const userDir = path.join(root, entry.name);
        const backups = path.join(userDir, 'backups', 'saveguard');
        targets.push({ root: path.join(userDir, 'chats'), kind: 'chats', backups });
        targets.push({ root: path.join(userDir, 'group chats'), kind: 'groups', backups });
    }
    return targets.filter(t => fs.existsSync(t.root));
}

/** Where the snapshots of a chat file live, or null if the file is not a chat. */
function snapDirFor(target, file) {
    const parts = path.relative(target.root, file).split(path.sep);
    const base = parts.at(-1).replace(/\.jsonl$/, '');
    if (target.kind === 'chats') {
        return parts.length === 2 ? path.join(target.backups, 'chats', parts[0], base) : null;
    }
    return parts.length === 1 ? path.join(target.backups, 'groups', base) : null;
}

function stamp(date = new Date()) {
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${p(date.getMilliseconds(), 3)}`;
}

async function listSnaps(dir) {
    let names = [];
    try {
        names = await fsp.readdir(dir);
    } catch {
        return [];
    }
    return names
        .map(name => {
            const m = SNAP_RE.exec(name);
            return m && { name, file: path.join(dir, name), count: Number(m[2]), flag: m[3], hash: m[4] };
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
}

function chatLines(buffer) {
    return buffer.toString('utf8').split('\n').filter(line => line.trim());
}

function lastMessage(lines) {
    if (lines.length < 2) return null;
    try {
        return JSON.parse(lines.at(-1));
    } catch {
        return null;
    }
}

async function relabel(snap, flag) {
    const name = snap.name.replace(SNAP_RE, (_, s, c, f, h) => `${s}_${c}_${flag}_${h}.jsonl.gz`);
    await fsp.rename(snap.file, path.join(path.dirname(snap.file), name));
}

async function writeSnap(dir, buffer, count, flag, hash) {
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${stamp()}_${String(count).padStart(5, '0')}_${flag}_${hash}.jsonl.gz`);
    const temp = `${file}.tmp`;
    await fsp.writeFile(temp, await gzip(buffer));
    await fsp.rename(temp, file);
}

async function prune(dir) {
    const snaps = await listSnaps(dir);
    const ring = snaps.filter(s => s.flag !== 'p');
    const shielded = snaps.filter(s => s.flag === 'p');
    const extra = [
        ...ring.slice(0, Math.max(0, ring.length - cfg.keep)),
        ...shielded.slice(0, Math.max(0, shielded.length - cfg.keepProtected)),
    ];
    for (const snap of extra) {
        await fsp.rm(snap.file, { force: true });
    }
}

/**
 * Records the given chat content as a snapshot.
 * One slot per round: repeated saves of the same round overwrite its slot, so the ring
 * of `keep` slots really spans `keep` rounds rather than `keep` saves.
 */
async function snapshot(dir, buffer, { protect = false } = {}) {
    const snaps = await listSnaps(dir);
    const latest = snaps.filter(s => s.flag !== 'p').at(-1);
    const lines = chatLines(buffer);

    // The chat file was emptied: never store that, but shield what we had.
    if (lines.length === 0) {
        if (latest) await relabel(latest, 'p');
        return prune(dir);
    }

    const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 10);
    const same = snaps.find(s => s.hash === hash);
    if (same) {
        if (protect && same.flag !== 'p') await relabel(same, 'p');
        return;
    }

    const count = lines.length - 1;
    if (protect) {
        await writeSnap(dir, buffer, count, 'p', hash);
        return prune(dir);
    }

    const flag = lastMessage(lines)?.is_user === true ? 'u' : 'a';
    let replaced = null;
    if (latest) {
        if (latest.count - count >= cfg.protectDrop) {
            await relabel(latest, 'p');
        } else if (latest.count === count || latest.flag === 'u') {
            replaced = latest;
        }
    }
    await writeSnap(dir, buffer, count, flag, hash);
    if (replaced) await fsp.rm(replaced.file, { force: true });
    return prune(dir);
}

/** Remembers when a chat went missing; returns that time, or 0 if it has no snapshots. */
async function markDeleted(dir) {
    const mark = path.join(dir, DELETED_MARK);
    try {
        return (await fsp.stat(mark)).mtimeMs;
    } catch {
        if (!(await listSnaps(dir)).length) return 0;
        await fsp.writeFile(mark, '');
        return Date.now();
    }
}

async function handleFile(target, file) {
    const dir = snapDirFor(target, file);
    if (!dir) return;
    let stat;
    try {
        stat = await fsp.stat(file);
    } catch {
        // Deleted or renamed away. Its snapshots stay, so the chat can still be brought back.
        seen.delete(file);
        return markDeleted(dir);
    }
    if (!stat.isFile()) return;
    seen.set(file, stat.mtimeMs);
    await fsp.rm(path.join(dir, DELETED_MARK), { force: true });
    await snapshot(dir, await fsp.readFile(file));
}

function touch(target, file) {
    if (stopped) return;
    clearTimeout(timers.get(file));
    timers.set(file, setTimeout(() => {
        timers.delete(file);
        enqueue(() => handleFile(target, file));
    }, cfg.settleMs));
}

async function walk(target) {
    const files = [];
    const depth = target.kind === 'chats' ? 2 : 1;
    async function visit(dir, level) {
        let entries = [];
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory() && level < depth) await visit(full, level + 1);
            else if (entry.isFile() && level === depth && entry.name.endsWith('.jsonl')) files.push(full);
        }
    }
    await visit(target.root, 1);
    return files;
}

/** Finds chat files whose modification time changed since we last looked. */
async function scan(target, { baseline = false } = {}) {
    for (const file of await walk(target)) {
        let mtime;
        try {
            mtime = (await fsp.stat(file)).mtimeMs;
        } catch {
            continue;
        }
        if (seen.get(file) === mtime) continue;
        if (baseline) seen.set(file, mtime);
        else touch(target, file);
    }
}

/**
 * Watches one directory (not its children). SillyTavern saves chats by writing a temporary
 * file and renaming it into place, which only a directory-level watcher sees reliably.
 */
function watchDir(target, dir) {
    if (watchers.has(dir)) return false;
    try {
        const watcher = fs.watch(dir, (_event, name) => {
            if (name && String(name).endsWith('.jsonl')) return touch(target, path.join(dir, String(name)));
            // Something else changed: possibly a new character folder that needs its own watcher.
            if (watchTarget(target) || !name) scan(target).catch(error => console.error(TAG, error));
        });
        watcher.on('error', () => {
            watcher.close();
            watchers.delete(dir);
        });
        watchers.set(dir, watcher);
        return true;
    } catch (error) {
        if (!warned.has(dir)) console.warn(TAG, `Cannot watch ${dir}: ${error.message}. Relying on periodic scans.`);
        warned.add(dir);
        return false;
    }
}

/** Makes sure a chat folder and (for character chats) each character folder is watched. */
function watchTarget(target) {
    let added = watchDir(target, target.root);
    if (target.kind !== 'chats') return added;
    let entries = [];
    try {
        entries = fs.readdirSync(target.root, { withFileTypes: true });
    } catch {
        return added;
    }
    for (const entry of entries) {
        if (entry.isDirectory() && watchDir(target, path.join(target.root, entry.name))) added = true;
    }
    return added;
}

/** Drops watchers whose folder was deleted, so a folder recreated later gets a fresh one. */
function dropDeadWatchers() {
    for (const [dir, watcher] of watchers) {
        if (fs.existsSync(dir)) continue;
        watcher.close();
        watchers.delete(dir);
    }
}

/** Removes snapshot folders whose chat has been gone for `orphanDays`. */
async function purgeOrphans() {
    const cutoff = Date.now() - cfg.orphanDays * 86400000;
    for (const target of listTargets()) {
        const base = path.join(target.backups, target.kind);
        const levels = target.kind === 'chats' ? 2 : 1;
        async function visit(dir, level, rel) {
            let entries = [];
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries.filter(e => e.isDirectory())) {
                const full = path.join(dir, entry.name);
                const relPath = path.join(rel, entry.name);
                if (level < levels) {
                    await visit(full, level + 1, relPath);
                    continue;
                }
                if (fs.existsSync(path.join(target.root, `${relPath}.jsonl`))) continue;
                if (await markDeleted(full) < cutoff) await fsp.rm(full, { recursive: true, force: true });
            }
        }
        await visit(base, 1, '');
    }
}

/** Makes the UI available to every user of this server without a separate install. */
function installUi() {
    const extensions = path.resolve('public/scripts/extensions');
    if (!cfg.installUi || !fs.existsSync(extensions)) return;
    const dest = path.join(extensions, 'third-party', UI_FOLDER);
    if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, UI_MARKER))) {
        return; // someone installed the extension there themselves; leave it alone
    }
    fs.mkdirSync(dest, { recursive: true });
    // This copy is not a Git checkout, so SillyTavern must not try to update it; the plugin does.
    const manifest = { ...readJson(path.join(PLUGIN_ROOT, 'manifest.json')), auto_update: false };
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 4));
    fs.cpSync(path.join(PLUGIN_ROOT, 'ui'), path.join(dest, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(dest, UI_MARKER), 'Managed by the ST-SaveGuard server plugin. Overwritten on server start.\n');
}

// ---------------------------------------------------------------- routes

function safeSegment(value) {
    const s = String(value ?? '');
    return s && s !== '.' && s !== '..' && !/[\\/\0]/.test(s) ? s : null;
}

/** Maps a request to { file, dir } for the chat it names, using the logged-in user's folders. */
function resolveChat(request) {
    const dirs = request.user?.directories;
    if (!dirs) return null;
    const body = request.body ?? {};
    const base = path.join(dirs.backups, 'saveguard');
    if (body.group_id !== undefined) {
        const id = safeSegment(body.group_id);
        return id && { file: path.join(dirs.groupChats, `${id}.jsonl`), dir: path.join(base, 'groups', id) };
    }
    const card = safeSegment(String(body.avatar_url ?? '').replace(/\.png$/i, ''));
    const name = safeSegment(body.file_name);
    return card && name && { file: path.join(dirs.chats, card, `${name}.jsonl`), dir: path.join(base, 'chats', card, name) };
}

async function describe(snap) {
    const stat = await fsp.stat(snap.file);
    let last = null;
    try {
        last = lastMessage(chatLines(await gunzip(await fsp.readFile(snap.file))));
    } catch {
        // unreadable snapshot: still list it, just without a preview
    }
    return {
        id: snap.name,
        time: stat.mtimeMs,
        messages: snap.count,
        state: { a: 'round', u: 'pending', p: 'protected' }[snap.flag],
        size: stat.size,
        name: typeof last?.name === 'string' ? last.name : '',
        preview: typeof last?.mes === 'string' ? last.mes.replace(/\s+/g, ' ').slice(0, 80) : '',
    };
}

function route(handler) {
    return async (request, response) => {
        try {
            await handler(request, response);
        } catch (error) {
            console.error(TAG, error);
            response.status(500).send({ error: 'SaveGuard failed, see the server console.' });
        }
    };
}

async function findSnap(request, response) {
    const chat = resolveChat(request);
    if (!chat) return void response.status(400).send({ error: 'bad chat' });
    const snap = SNAP_RE.test(String(request.body?.id)) && (await listSnaps(chat.dir)).find(s => s.name === request.body.id);
    if (!snap) return void response.status(404).send({ error: 'snapshot not found' });
    return { chat, snap };
}

export const info = {
    id: 'saveguard',
    name: 'ST-SaveGuard',
    description: 'Keeps a rolling set of server-side snapshots for every chat.',
};

export async function init(router) {
    try {
        installUi();
    } catch (error) {
        console.warn(TAG, `Could not install the UI extension: ${error.message}`);
    }

    // A folder seen for the first time is only indexed: chats that already exist are not
    // copied wholesale, they get their first snapshot the next time they are saved.
    const known = new Set();
    const refresh = async () => {
        dropDeadWatchers();
        for (const target of listTargets()) {
            await scan(target, { baseline: !known.has(target.root) });
            known.add(target.root);
            watchTarget(target);
        }
    };
    await refresh();
    scanTimer = setInterval(() => refresh().catch(error => console.error(TAG, error)), cfg.scanSeconds * 1000);
    purgeTimer = setInterval(() => enqueue(purgeOrphans), 86400000);
    setTimeout(() => !stopped && enqueue(purgeOrphans), 300000).unref();
    scanTimer.unref();
    purgeTimer.unref();

    router.get('/status', (_request, response) => {
        response.send({ ok: true, version: VERSION, keep: cfg.keep });
    });

    router.post('/list', route(async (request, response) => {
        const chat = resolveChat(request);
        if (!chat) return response.status(400).send({ error: 'bad chat' });
        const snaps = await listSnaps(chat.dir);
        response.send({ snapshots: (await Promise.all(snaps.map(describe))).reverse() });
    }));

    // Chats of one character that no longer exist but still have snapshots.
    router.post('/deleted', route(async (request, response) => {
        const dirs = request.user?.directories;
        const card = safeSegment(String(request.body?.avatar_url ?? '').replace(/\.png$/i, ''));
        if (!dirs || !card) return response.status(400).send({ error: 'bad character' });
        const base = path.join(dirs.backups, 'saveguard', 'chats', card);
        let names = [];
        try {
            names = (await fsp.readdir(base, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
        } catch {
            // no snapshots for this character yet
        }
        const chats = [];
        for (const name of names) {
            if (fs.existsSync(path.join(dirs.chats, card, `${name}.jsonl`))) continue;
            const dir = path.join(base, name);
            const newest = (await listSnaps(dir)).at(-1);
            if (!newest) continue;
            chats.push({ file_name: name, deleted: await markDeleted(dir), latest: await describe(newest) });
        }
        response.send({ chats: chats.sort((a, b) => b.latest.time - a.latest.time) });
    }));

    router.post('/download', route(async (request, response) => {
        const found = await findSnap(request, response);
        if (!found) return;
        response.type('application/octet-stream').send(await gunzip(await fsp.readFile(found.snap.file)));
    }));

    router.post('/restore', route(async (request, response) => {
        const found = await findSnap(request, response);
        if (!found) return;
        const { chat, snap } = found;
        const data = await gunzip(await fsp.readFile(snap.file));
        await enqueue(async () => {
            // Shield whatever is in the chat right now, so a restore can itself be undone.
            try {
                await snapshot(chat.dir, await fsp.readFile(chat.file), { protect: true });
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            await fsp.mkdir(path.dirname(chat.file), { recursive: true });
            const temp = `${chat.file}.sgtmp`;
            await fsp.writeFile(temp, data);
            await fsp.rename(temp, chat.file);
        });
        response.send({ ok: true });
    }));

    console.log(TAG, `v${VERSION} watching ${watchers.size} folder(s) under ${dataRoot()}, keeping ${cfg.keep} rounds per chat.`);
}

export async function exit() {
    stopped = true;
    clearInterval(scanTimer);
    clearInterval(purgeTimer);
    for (const timer of timers.values()) clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    await queue;
}
