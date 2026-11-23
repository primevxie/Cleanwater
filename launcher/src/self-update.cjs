const {app} = require('electron');
const {autoUpdater} = require('electron-updater');

function startSelfUpdate(report, logError) {
    if (!app.isPackaged || process.platform !== 'win32') return null;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.disableWebInstaller = true;
    let ready = false;
    let version;
    let lastPercent = -1;
    autoUpdater.on('update-available', info => {
        version = info.version;
        lastPercent = -1;
        report({stage: 'downloading', version});
    });
    autoUpdater.on('download-progress', progress => {
        const percent = Math.min(100, Math.floor(progress.percent));
        if (percent === lastPercent) return;
        lastPercent = percent;
        report({stage: 'downloading', version, percent});
    });
    autoUpdater.on('update-downloaded', info => {
        ready = true;
        version = info.version;
        report({stage: 'ready', version});
    });
    autoUpdater.on('error', error => {
        logError(error);
        if (!ready) report({stage: 'idle'});
    });

    function check() {
        if (!ready) autoUpdater.checkForUpdates().catch(() => {});
    }

    check();
    const timer = setInterval(check, 15 * 60 * 1000);
    timer.unref();

    return {
        restart() {
            if (!ready) return false;
            report({stage: 'installing', version});
            autoUpdater.quitAndInstall(true, true);
            return true;
        }
    };
}

module.exports = {startSelfUpdate};
