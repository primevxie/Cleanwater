const ui = id => document.getElementById(id);
const dialog = ui('onboarding');
const field = ui('username');
const submit = ui('continue');
const form = ui('account-form');
const help = ui('username-help');
const launch = ui('launch');
const launchLabel = launch.querySelector('span');
const dismiss = ui('dismiss-profile');
const cancel = ui('cancel');
const edit = ui('edit-profile');
const log = ui('open-log');
let username = '';
let installedVersion;
let busy = false;

function showProfile() {
    const action = username ? 'Close username settings' : 'Close launcher';
    dismiss.setAttribute('aria-label', action);
    dismiss.textContent = username ? 'Cancel' : 'Close';
    field.value = username;
    help.classList.remove('error');
    help.textContent = '3–16 letters, numbers, or underscores.';
    field.removeAttribute('aria-invalid');
    if (!dialog.open) dialog.showModal();
    field.focus();
    if (username) field.select();
}

async function closeProfile() {
    if (!username || dialog.classList.contains('closing')) return;
    dialog.classList.add('closing');
    await new Promise(resolve => {
        dialog.addEventListener('animationend', resolve, {once: true});
        setTimeout(resolve, 220);
    });
    dialog.close();
    dialog.classList.remove('closing');
    launch.focus();
}

function render(state) {
    if (state.clientVersion) installedVersion = state.clientVersion;
    const running = state.stage === 'running';
    const failed = state.stage === 'error';
    const working = ['metadata', 'java', 'game', 'assets', 'launch'].includes(state.stage);
    busy = working || running;
    const progress = Math.round(Math.max(0, Math.min(1, state.fraction ?? 0)) * 100);
    ui('status').dataset.state = state.stage;
    ui('status').textContent = state.label || (installedVersion ? 'Ready to play' : 'Ready to install');
    ui('detail').textContent = working
        ? [state.detail, progress + '%'].filter(Boolean).join(' · ')
        : failed ? (state.gameLog ? 'Open the game log for details.' : 'You can retry the installation.')
            : installedVersion ? 'Clearwater ' + installedVersion : 'Minecraft and dependencies install on first launch.';
    ui('progress-track').hidden = !working;
    ui('progress-track').setAttribute('aria-valuenow', progress);
    ui('progress-fill').style.setProperty('--progress', progress / 100);
    cancel.hidden = !working || state.stage === 'launch';
    cancel.disabled = false;
    log.hidden = !state.gameLog;
    launch.hidden = working;
    launch.disabled = running;
    launchLabel.textContent = running ? 'Playing' : installedVersion ? 'Play' : failed ? 'Try again' : 'Install and play';
    edit.disabled = busy;
    ui('profile-name').textContent = username || 'Set username';
}

function fail(message) {
    render({stage: 'error', label: message});
}

form.addEventListener('submit', async event => {
    event.preventDefault();
    const name = field.value.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
        help.textContent = 'Enter 3–16 letters, numbers, or underscores.';
        help.classList.add('error');
        field.setAttribute('aria-invalid', 'true');
        field.focus();
        return;
    }
    submit.disabled = true;
    try {
        if (!await window.clearwater.saveUsername(name)) throw new Error('Could not save this username.');
        username = name;
        ui('profile-name').textContent = name;
        await closeProfile();
    } catch {
        help.textContent = 'Could not save the username. Try again.';
        help.classList.add('error');
    } finally {
        submit.disabled = false;
    }
});

field.addEventListener('input', () => {
    if (!help.classList.contains('error')) return;
    help.classList.remove('error');
    help.textContent = '3–16 letters, numbers, or underscores.';
    field.removeAttribute('aria-invalid');
});
dialog.addEventListener('cancel', event => {
    event.preventDefault();
    closeProfile();
});
dismiss.addEventListener('click', () => {
    if (username) closeProfile();
    else window.clearwater.closeWindow();
});
edit.addEventListener('click', showProfile);

launch.addEventListener('click', async () => {
    if (busy) return;
    if (!username) {
        showProfile();
        return;
    }
    render({stage: 'metadata', label: 'Checking files', fraction: 0});
    try {
        const launched = await window.clearwater.play();
        if (!launched) render((await window.clearwater.state()).progress);
    } catch {
        fail('Could not start the launcher. Try again.');
    }
});

cancel.addEventListener('click', () => {
    cancel.disabled = true;
    window.clearwater.cancel();
});
ui('profile-folder').addEventListener('click', async () => {
    try {
        if (await window.clearwater.profile()) fail('Could not open the game folder.');
    } catch {
        fail('Could not open the game folder.');
    }
});
log.addEventListener('click', () => window.clearwater.gameLog());

window.clearwater.onProgress(render);
window.clearwater.state().then(state => {
    username = state.username;
    installedVersion = state.installedVersion;
    ui('game-version').textContent = 'Minecraft ' + state.minecraft;
    render(state.progress);
    if (!username) showProfile();
}).catch(() => fail('Could not read your launcher profile.'));
