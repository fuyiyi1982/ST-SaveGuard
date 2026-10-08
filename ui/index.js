// ST-SaveGuard — UI extension
// 1. Shows whether the current chat has actually reached the server.
// 2. Asks before the page is closed while a save is still on its way.
// 3. Lets the player roll the chat back to a server-side snapshot (needs the server plugin).
// It only observes SillyTavern's own save requests; it never uploads the chat a second time.

const API = '/api/plugins/saveguard';
const SAVE_URL = /\/api\/chats\/(group\/)?save(?:[?#]|$)/;
const RESCUE_MS = 10000;          // unsaved changes with no save on its way for this long get saved
const RETRY_DELAYS = [3000, 10000, 30000];
const COLLAPSE_MS = 4000;

const ctx = () => globalThis.SillyTavern.getContext();

const state = {
    inflight: 0,
    since: 0,          // when the oldest running save started
    failed: false,
    lastOk: 0,
    savedPrint: null,  // fingerprint of the chat as the server last received it
    dirtySince: 0,
    rescued: null,
    retries: 0,
    retryTimer: null,
};

let chip, chipText;

// ------------------------------------------------------------ save tracking

function isGenerating() {
    return document.body.dataset.generating === 'true';
}

/** A cheap signature of the chat in memory: enough to notice new, removed, edited or swiped messages. */
function fingerprint() {
    const c = ctx();
    const id = c.getCurrentChatId();
    if (!id) return null;
    const last = c.chat.at(-1);
    return [id, c.chat.length, last?.mes?.length ?? 0, last?.swipe_id ?? '', last?.send_date ?? ''].join('|');
}

function isDirty() {
    const print = fingerprint();
    return print !== null && state.savedPrint !== null && print !== state.savedPrint;
}

function status() {
    if (state.inflight > 0) return 'saving';
    if (state.failed) return 'failed';
    if (isGenerating()) return 'generating';
    if (isDirty()) return 'pending';
    return 'saved';
}

/** If the chat stays changed with no save on its way, ask SillyTavern to save it (once per change). */
function rescue(current) {
    if (current !== 'pending') return void (state.dirtySince = 0);
    const print = fingerprint();
    state.dirtySince ||= Date.now();
    if (Date.now() - state.dirtySince < RESCUE_MS || state.rescued === print) return;
    state.rescued = print;
    ctx().saveChat();
}

function clock(time) {
    return new Date(time).toLocaleTimeString([], { hour12: false });
}

function render() {
    if (!chip) return;
    const now = Date.now();
    const current = status();
    rescue(current);
    const seconds = Math.floor((now - state.since) / 1000);
    const text = {
        saving: seconds >= 2 ? `保存中… ${seconds}s` : '保存中…',
        failed: '保存失败 ✗',
        generating: '生成中 · 未保存',
        pending: '待保存…',
        saved: state.lastOk ? `已保存 ✓ ${clock(state.lastOk)}` : '已保存 ✓',
    }[current];
    chip.dataset.state = current;
    chip.classList.toggle('sg-collapsed', current === 'saved' && now - state.lastOk > COLLAPSE_MS);
    chipText.textContent = text;
    chip.title = {
        saving: '存档正在上传到服务器，请先不要关闭页面',
        failed: '存档没有传到服务器，正在自动重试；点击可手动保存',
        generating: '回复还在生成，完成后才会保存',
        pending: '有改动等待保存',
        saved: '存档已在服务器上，可以放心关闭。点击可恢复存档',
    }[current];
}

function scheduleRetry() {
    clearTimeout(state.retryTimer);
    const delay = RETRY_DELAYS[state.retries];
    if (delay === undefined) return;
    const chatId = ctx().getCurrentChatId();
    state.retryTimer = setTimeout(() => {
        if (!state.failed || state.inflight > 0 || ctx().getCurrentChatId() !== chatId) return;
        state.retries++;
        ctx().saveChat();
    }, delay);
}

function saveStarted() {
    if (state.inflight++ === 0) state.since = Date.now();
    render();
    return fingerprint();
}

function saveFinished(result, print) {
    state.inflight = Math.max(0, state.inflight - 1);
    if (result === 'ok') {
        state.failed = false;
        state.retries = 0;
        state.lastOk = Date.now();
        state.savedPrint = print;
        clearTimeout(state.retryTimer);
        setTimeout(render, COLLAPSE_MS + 50);
    } else if (result === 'fail') {
        state.failed = true;
        scheduleRetry();
    }
    render();
}

/** Watches SillyTavern's own chat save requests go out and come back. */
function hookFetch() {
    const original = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : input?.url ?? String(input);
        const promise = original.call(this, input, init);
        if (!SAVE_URL.test(url)) return promise;
        const print = saveStarted();
        promise.then(async response => {
            if (response.ok) return saveFinished('ok', print);
            // An integrity conflict is handled by SillyTavern's own dialog; do not retry over it.
            const body = await response.clone().json().catch(() => null);
            saveFinished(body?.error === 'integrity' ? 'handled' : 'fail');
        }, () => saveFinished('fail'));
        return promise;
    };
}

/** A chat that has just been loaded is, by definition, what the server has. */
function chatChanged() {
    clearTimeout(state.retryTimer);
    Object.assign(state, { failed: false, lastOk: 0, retries: 0, dirtySince: 0, rescued: null, savedPrint: fingerprint() });
    render();
}

function isUnsafeToLeave() {
    return status() !== 'saved';
}

// ------------------------------------------------------------ restore panel

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function currentChat() {
    const c = ctx();
    if (c.groupId) {
        const group = c.groups.find(g => g.id == c.groupId);
        return group?.chat_id ? { group_id: group.chat_id } : null;
    }
    const character = c.characters[c.characterId];
    return character?.chat ? { avatar_url: character.avatar, file_name: character.chat } : null;
}

async function call(path, body) {
    const response = await fetch(API + path, {
        method: body ? 'POST' : 'GET',
        headers: ctx().getRequestHeaders(),
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
}

async function waitForSaves(timeout = 15000) {
    const end = Date.now() + timeout;
    while (state.inflight > 0 && Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return state.inflight === 0;
}

function when(time) {
    return new Date(time).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

async function restore(chat, snap) {
    const c = ctx();
    if (isGenerating()) {
        return void toastr.warning('回复还在生成，等它结束后再还原。', '存档守卫');
    }
    const confirmed = await c.callGenericPopup(
        `把当前聊天还原到 ${when(snap.time)}（${snap.messages} 楼）？\n现在的内容会先留一份保护备份，之后还能再还原回来。`,
        c.POPUP_TYPE.CONFIRM,
    );
    if (confirmed !== c.POPUP_RESULT.AFFIRMATIVE) return;

    // Flush anything SillyTavern still has queued, so it cannot land on top of the restored file.
    await c.saveChat();
    if (!await waitForSaves()) {
        return void toastr.error('当前存档还没保存完，稍后再试。', '存档守卫');
    }
    try {
        await call('/restore', { ...chat, id: snap.id });
        await c.reloadCurrentChat();
        toastr.success(`已还原到 ${when(snap.time)}`, '存档守卫');
    } catch (error) {
        console.error('[SaveGuard]', error);
        toastr.error('还原失败，聊天没有被改动。', '存档守卫');
    }
}

async function download(chat, snap) {
    try {
        const blob = await (await call('/download', { ...chat, id: snap.id })).blob();
        const link = el('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${chat.file_name ?? chat.group_id}_${snap.messages}楼.jsonl`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    } catch (error) {
        console.error('[SaveGuard]', error);
        toastr.error('下载失败。', '存档守卫');
    }
}

async function buildList(box, popup) {
    box.replaceChildren(el('div', 'sg-note', '读取中…'));
    const chat = currentChat();
    if (!chat) return box.replaceChildren(el('div', 'sg-note', '先打开一个聊天。'));

    let snaps;
    try {
        snaps = (await (await call('/list', chat)).json()).snapshots;
    } catch {
        return box.replaceChildren(el('div', 'sg-note', '这个酒馆的服务器没有安装存档守卫的服务端插件，所以没有可恢复的备份。保存状态提示和关闭提醒仍然有效。'));
    }
    if (!snaps.length) {
        return box.replaceChildren(el('div', 'sg-note', '这个聊天还没有备份。再玩一回合就会有第一份。'));
    }

    const rows = snaps.map(snap => {
        const row = el('div', 'sg-row');
        const main = el('div', 'sg-row-main');
        const head = el('div', 'sg-row-head');
        head.append(el('b', '', when(snap.time)), el('span', 'sg-floor', `${snap.messages} 楼`));
        if (snap.state === 'pending') head.append(el('span', 'sg-tag', '回合进行中'));
        if (snap.state === 'protected') head.append(el('span', 'sg-tag sg-tag-shield', '保护备份'));
        main.append(head, el('div', 'sg-preview', snap.preview ? `${snap.name}：${snap.preview}` : '（空）'));

        const restoreButton = el('div', 'menu_button', '还原');
        restoreButton.addEventListener('click', async () => {
            await popup.completeAffirmative();
            await restore(chat, snap);
        });
        const downloadButton = el('div', 'menu_button fa-solid fa-download');
        downloadButton.title = '下载这份存档';
        downloadButton.addEventListener('click', () => download(chat, snap));
        row.append(main, restoreButton, downloadButton);
        return row;
    });
    box.replaceChildren(...rows);
}

async function openPanel() {
    const c = ctx();
    const root = el('div', 'sg-panel');
    root.append(el('h3', '', '存档守卫'));

    const bar = el('div', 'sg-bar');
    const line = el('span', 'sg-bar-status');
    const saveNow = el('div', 'menu_button', '立即保存');
    saveNow.addEventListener('click', () => ctx().saveChat());
    bar.append(line, saveNow);

    const list = el('div', 'sg-list');
    root.append(bar, el('div', 'sg-hint', '每回合自动在服务器上留一份，只保留最近几回合。还原不会丢掉现在的内容。'), list);

    const mirror = () => {
        line.textContent = chipText.textContent;
        line.dataset.state = chip.dataset.state;
    };
    mirror();
    const tick = setInterval(mirror, 300);
    const popup = new c.Popup(root, c.POPUP_TYPE.TEXT, '', { okButton: '关闭', allowVerticalScrolling: true });
    buildList(list, popup);
    await popup.show();
    clearInterval(tick);
}

// ------------------------------------------------------------ setup

function mount() {
    chip = el('div', 'sg-chip');
    chip.id = 'saveguard-chip';
    chipText = el('span', 'sg-chip-text');
    chip.append(el('span', 'sg-chip-dot'), chipText);
    chip.addEventListener('click', openPanel);
    document.body.append(chip);

    const menu = document.getElementById('extensionsMenu');
    if (menu) {
        const item = el('div', 'list-group-item flex-container flexGap5 interactable');
        item.tabIndex = 0;
        item.append(el('div', 'fa-solid fa-life-ring extensionsMenuExtensionButton'), el('span', '', '恢复存档'));
        item.addEventListener('click', openPanel);
        menu.append(item);
    }
}

function start() {
    const { eventSource, eventTypes } = ctx();
    hookFetch();
    mount();

    eventSource.on(eventTypes.CHAT_CHANGED, chatChanged);
    for (const name of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED']) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], () => setTimeout(render, 0));
    }

    // Keeps the elapsed-seconds counter, the generating state and the unsaved check fresh.
    setInterval(render, 500);

    window.addEventListener('beforeunload', event => {
        if (!isUnsafeToLeave()) return;
        event.preventDefault();
        event.returnValue = true;
    });

    render();
}

start();
