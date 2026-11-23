const {app, BrowserWindow, ipcMain, nativeTheme, shell} = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {execFile, spawn} = require('node:child_process');
const {promisify} = require('node:util');
const {pathToFileURL} = require('node:url');
const {MINECRAFT, LOADER, prepare, validUsername} = require('./install.cjs');
const {fileBusy, inside, readJson, saveJson} = require('./download.cjs');
const {startSelfUpdate} = require('./self-update.cjs');

const appData = process.platform === 'win32' ? process.env.LOCALAPPDATA || app.getPath('appData') : app.getPath('appData');
const root = path.join(appData, 'ClearwaterLauncher');
const settingsFile = inside(root, 'settings.json');
const logFile = inside(root, 'launcher-game.log');
const runArgs = inside(root, 'downloads/launch.args');
const page = path.join(__dirname, 'ui', 'index.html');
const pageUrl = pathToFileURL(page).href;
let window;
let installation;
let game;
let quitting = false;
let username = '';
let installedVersion;
let progress = {stage: 'idle'};
let updateState = {stage: 'idle'};
let selfUpdate;
const run = promisify(execFile);

fs.mkdirSync(inside(root, 'desktop'), {recursive: true});
app.setPath('userData', inside(root, 'desktop'));

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
    if (fileBusy(error)) return 'A game file is still in use. Close other Minecraft windows, then try again.';
    if (error.syscall) return 'Could not access the launcher’s game files.';
    if (error instanceof TypeError && error.message === 'fetch failed') {
        return 'Could not reach the download servers. Try again when you’re online.';
    }
    return error.message;
}

async function profileInUse() {
    if (process.platform === 'linux') {
        const uid = process.getuid();
        for (const pid of await fsp.readdir('/proc')) {
            if (!/^\d+$/.test(pid)) continue;
            const entry = '/proc/' + pid;
            try {
                if ((await fsp.stat(entry)).uid !== uid || (await fsp.readFile(entry + '/comm', 'utf8')).trim() !== 'java') continue;
                const args = await fsp.readFile(entry + '/cmdline', 'utf8');
                if (args.split('\0').includes('@' + runArgs)) return true;
            } catch (error) {
                if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
            }
        }
        return false;
    }
    const command = String.raw`
        $file = $env:CLEARWATER_PROFILE_ARGS
        Get-CimInstance Win32_Process -Filter "Name='java.exe' OR Name='javaw.exe'" |
            Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($file, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
            Select-Object -First 1 -ExpandProperty ProcessId
    `;
    try {
        const {stdout} = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
            windowsHide: true, timeout: 5000, maxBuffer: 4096,
            env: {...process.env, CLEARWATER_PROFILE_ARGS: runArgs}
        });
        return /\d/.test(stdout);
    } catch {
        return false;
    }
}

function reportLauncherUpdate(state) {
    updateState = state;
    if (window && !window.isDestroyed()) window.webContents.send('clearwater:launcher-update', state);
}

function logUpdateError(message) {
    fsp.appendFile(inside(root, 'launcher-update.log'), `${new Date().toISOString()} ${message}\n`).catch(() => {});
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
        if (await profileInUse()) {
            update({stage: 'error', label: 'Minecraft is already running.',
                detail: 'Close the other Minecraft window before launching again.'});
            return false;
        }
        active.signal.throwIfAborted();
        const ready = await prepare(root, username, active.signal, update);
        if (ready.updateError) logUpdateError(ready.updateError);
        active.signal.throwIfAborted();
        installedVersion = ready.clientVersion;
        await saveJson(settingsFile, {username, installedVersion});
        active.signal.throwIfAborted();
        const child = launchGame(ready);
        game = child;
        child.once('spawn', () => update({stage: 'running', label: 'Minecraft is running',
            clientVersion: installedVersion,
            detail: ready.updateError ? `Using Clearwater ${installedVersion}. The update will retry next launch.` : undefined}));
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
        height: 373,
        minWidth: 440,
        minHeight: 326,
        show: false,
        backgroundColor: '#202125',
        icon: path.join(__dirname, 'ui', 'assets', process.platform === 'linux' ? 'clearwater.png' : 'clearwater.ico'),
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
    handle('state', () => ({username, installedVersion, minecraft: MINECRAFT, fabric: LOADER, progress, updateState}));
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
    handle('restart', () => !installation && !game && selfUpdate?.restart());
    handle('close', () => window.close());
    app.on('before-quit', () => { quitting = true; });
    app.on('window-all-closed', () => app.quit());
    app.whenReady().then(async () => {
        await createWindow();
        selfUpdate = startSelfUpdate(reportLauncherUpdate, error => logUpdateError(error.message));
    }).catch(error => { console.error(error); app.quit(); });
}
