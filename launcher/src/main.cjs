const {app, BrowserWindow, ipcMain, nativeTheme, shell} = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {MINECRAFT, LOADER, prepare, validUsername} = require('./install.cjs');
const {inside, readJson, saveJson} = require('./download.cjs');

const root = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'ClearwaterLauncher');
const settingsFile = inside(root, 'settings.json');
const logFile = inside(root, 'launcher-game.log');
const page = path.join(__dirname, 'ui', 'index.html');
const pageUrl = pathToFileURL(page).href;
let window;
let installation;
let game;
let quitting = false;
let username = '';
let installedVersion;
let progress = {stage: 'idle'};

function update(state) {
    progress = state;
    if (window && !window.isDestroyed()) window.webContents.send('clearwater:progress', state);
}

function handle(channel, action) {
    ipcMain.handle('clearwater:' + channel, async (event, ...args) => {
        if (!window || window.isDestroyed() || event.sender !== window.webContents ||
            event.senderFrame?.url !== pageUrl) throw new Error('Unknown launcher window.');
        return action(...args);
    });
}

async function errorDetails(error) {
    await fsp.writeFile(inside(root, 'launcher-error.log'), String(error.stack || error), 'utf8').catch(() => {});
    if (error instanceof TypeError && error.message === 'fetch failed') {
        return 'Could not reach the download servers. Try again when you’re online.';
    }
    return error.message;
}

function launchGame(config) {
    const output = fs.openSync(logFile, 'w');
    try {
        return spawn(config.java, ['@' + config.argsPath], {
            cwd: config.profile, detached: true, windowsHide: true, stdio: ['ignore', output, output]
        });
    } finally {
        fs.closeSync(output);
    }
}

async function play() {
    if (installation || game || !validUsername(username)) return false;
    const active = new AbortController();
    installation = active;
    try {
        const ready = await prepare(root, username, active.signal, update);
        active.signal.throwIfAborted();
        installedVersion = ready.clientVersion;
        await saveJson(settingsFile, {username, installedVersion});
        active.signal.throwIfAborted();
        const child = launchGame(ready);
        game = child;
        child.once('spawn', () => update({stage: 'running', label: 'Minecraft is running', clientVersion: installedVersion}));
        child.once('error', async error => {
            if (game === child) game = null;
            update({stage: 'error', label: await errorDetails(error)});
            if (window && !window.isVisible()) app.quit();
        });
        child.once('exit', code => {
            if (game !== child) return;
            game = null;
            update(code === 0 ? {stage: 'idle', clientVersion: installedVersion}
                : {stage: 'error', label: `Minecraft closed with exit code ${code}.`, gameLog: true, clientVersion: installedVersion});
            if (window && !window.isVisible()) app.quit();
        });
        return true;
    } catch (error) {
        if (active.signal.aborted) update({stage: 'idle', clientVersion: installedVersion});
        else update({stage: 'error', label: await errorDetails(error), clientVersion: installedVersion});
        return false;
    } finally {
        installation = null;
    }
}

async function createWindow() {
    await fsp.mkdir(root, {recursive: true});
    const settings = await readJson(settingsFile, {});
    username = validUsername(settings.username) ? settings.username : '';
    installedVersion = typeof settings.installedVersion === 'string' ? settings.installedVersion : undefined;
    nativeTheme.themeSource = 'dark';
    window = new BrowserWindow({
        title: 'Cleanwater Launcher',
        width: 500,
        height: 344,
        minWidth: 440,
        minHeight: 326,
        show: false,
        backgroundColor: '#202125',
        icon: path.join(__dirname, 'ui', 'assets', 'clearwater.ico'),
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.once('ready-to-show', () => window.show());
    window.on('close', event => {
        if (!game || quitting) return;
        event.preventDefault();
        window.hide();
    });
    window.on('closed', () => { window = null; installation?.abort(); });
    await window.loadFile(page);
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!window) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
    });
    handle('state', () => ({username, installedVersion, minecraft: MINECRAFT, fabric: LOADER, progress}));
    handle('username', async value => {
        if (!validUsername(value) || installation || game) return false;
        await saveJson(settingsFile, {username: value, installedVersion});
        username = value;
        return true;
    });
    handle('play', play);
    handle('cancel', () => installation?.abort());
    handle('profile', async () => {
        const profile = inside(root, 'profile');
        await fsp.mkdir(profile, {recursive: true});
        return shell.openPath(profile);
    });
    handle('game-log', () => shell.openPath(logFile));
    handle('close', () => window.close());
    app.on('before-quit', () => { quitting = true; });
    app.on('window-all-closed', () => app.quit());
    app.whenReady().then(createWindow).catch(error => { console.error(error); app.quit(); });
}
