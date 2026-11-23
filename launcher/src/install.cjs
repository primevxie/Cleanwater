const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createHash, randomUUID} = require('node:crypto');
const Zip = require('adm-zip');
const {
    ensureFile, fileBusy, inside, installVerifiedFile, metadata, pool, readJson, request, saveJson, verifiedFile
} = require('./download.cjs');

const MINECRAFT = '26.3';
const LOADER = '0.20.1';
const LAUNCHER_VERSION = require('../package.json').version;
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC = `https://meta.fabricmc.net/v2/versions/loader/${MINECRAFT}/${LOADER}/profile/json`;
const RELEASE = 'https://api.github.com/repos/primevxie/cleanwaterjars/releases/latest';
const MODS = [
    ['fabric-api.jar', 'Zns5SSRA'],
    ['in-game-account-switcher.jar', 'oS3Q4s88'],
    ['viafabricplus.jar', 'DACOoCin']
];

const validUsername = value => typeof value === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(value);

function offlineUuid(username) {
    const hash = createHash('md5').update('OfflinePlayer:' + username).digest();
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.toString('hex');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function rulesAllow(rules) {
    if (!rules) return true;
    let allowed = false;
    for (const rule of rules) {
        const system = rule.os;
        if (system?.name && system.name !== 'windows') continue;
        if (system?.arch && !new RegExp(system.arch).test('amd64')) continue;
        if (system?.version && !new RegExp(system.version).test(os.release())) continue;
        if (rule.features && Object.values(rule.features).some(Boolean)) continue;
        allowed = rule.action === 'allow';
    }
    return allowed;
}

function expandArgs(args, values) {
    return (args || []).flatMap(item => {
        if (typeof item === 'string') return [item];
        return rulesAllow(item.rules) ? [item.value].flat() : [];
    }).map(arg => arg.replace(/\$\{([^}]+)}/g, (_, key) => {
        if (!Object.hasOwn(values, key)) throw new Error(`Minecraft requested an unsupported launch argument (${key}).`);
        return values[key];
    }));
}

function runtimeRelease(data) {
    return Array.isArray(data?.assets) && data.assets.find(asset =>
        /^clearwater-client-[0-9][0-9A-Za-z.+-]*\.jar$/.test(asset.name)
        && !/-(?:sources|javadoc|dev)\.jar$/.test(asset.name)
        && /^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')
        && typeof asset.browser_download_url === 'string'
        && asset.browser_download_url.startsWith('https://github.com/primevxie/cleanwaterjars/releases/download/'));
}

async function profiles(cache, signal) {
    const manifest = await metadata(MANIFEST, inside(cache, 'game-manifest.json'), signal, {
        validate: value => Array.isArray(value?.versions) && value.versions.some(v => v.id === MINECRAFT)
    });
    const entry = manifest.versions.find(v => v.id === MINECRAFT);
    const vanillaFile = await ensureFile(cache, `versions/${MINECRAFT}.json`, entry, signal);
    const vanilla = await readJson(vanillaFile, null);
    if (vanilla?.id !== MINECRAFT || !vanilla?.downloads?.client) throw new Error('Invalid Minecraft profile.');
    const fabric = await metadata(FABRIC, inside(cache, `fabric-${MINECRAFT}-${LOADER}.json`), signal, {
        validate: value => value?.inheritsFrom === MINECRAFT && typeof value.mainClass === 'string'
    });
    return {vanilla, fabric};
}

async function javaExecutable(root, cache, major, signal, emit) {
    const runtime = inside(root, `runtime/java-${major}`);
    const executable = inside(runtime, 'bin/java.exe');
    if (await fs.stat(executable).then(info => info.isFile(), () => false)) return executable;
    emit('java', 'Downloading Java', 0.04);
    const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&heap_size=normal&image_type=jre&os=windows&vendor=eclipse`;
    const results = await metadata(url, inside(cache, `java-${major}.json`), signal, {
        validate: value => /^https:\/\/github\.com\/adoptium\/temurin\d+-binaries\/releases\/download\//.test(value?.[0]?.binary?.package?.link)
    });
    const pkg = results[0].binary.package;
    const archive = await ensureFile(cache, `runtime/${pkg.name}`, {
        url: pkg.link, sha256: pkg.checksum, size: pkg.size
    }, signal, (bytes, size) => emit('java', 'Downloading Java', 0.04 + 0.14 * bytes / size));
    emit('java', 'Installing Java', 0.18);
    const stage = inside(root, 'runtime/stage-' + randomUUID());
    await fs.mkdir(stage, {recursive: true});
    try {
        const zip = new Zip(archive);
        for (const entry of zip.getEntries()) inside(stage, entry.entryName);
        const javaEntry = zip.getEntries().find(entry => !entry.isDirectory && /(?:^|\/)bin\/java\.exe$/.test(entry.entryName));
        if (!javaEntry) throw new Error('The Java archive did not include a Windows runtime.');
        const extracted = path.dirname(path.dirname(inside(stage, javaEntry.entryName)));
        await new Promise((resolve, reject) => zip.extractAllToAsync(stage, false, error => error ? reject(error) : resolve()));
        signal.throwIfAborted();
        await fs.rm(runtime, {recursive: true, force: true});
        await fs.rename(extracted, runtime);
        await fs.access(executable);
        return executable;
    } finally {
        await fs.rm(stage, {recursive: true, force: true});
    }
}

function mavenLibrary(library) {
    const [group, artifact, version, classifier] = library.name.split(':');
    const key = [group, artifact, classifier].join(':');
    const filename = `${artifact}-${version}${classifier ? '-' + classifier : ''}.jar`;
    const relative = `${group.replaceAll('.', '/')}/${artifact}/${version}/${filename}`;
    return {key, relative, file: library.downloads?.artifact || {
        ...library, url: new URL(relative, library.url || 'https://libraries.minecraft.net/').href
    }};
}

async function ensureLibrary(cache, lib, signal) {
    if (!lib.file.sha512 && !lib.file.sha256 && !lib.file.sha1) {
        const checksumFile = inside(cache, `checksums/${lib.relative}.json`);
        const saved = await readJson(checksumFile, null);
        if (saved?.sha1) {
            lib.file.sha1 = saved.sha1;
        } else {
            lib.file.sha1 = (await request(lib.file.url + '.sha1', signal, response => response.text())).trim().split(/\s+/)[0];
            if (!/^[a-f0-9]{40}$/i.test(lib.file.sha1)) throw new Error('Invalid Fabric library checksum.');
            await saveJson(checksumFile, {sha1: lib.file.sha1});
        }
    }
    return ensureFile(cache, 'libraries/' + (lib.file.path || lib.relative), lib.file, signal);
}

async function clientRelease(cache, signal) {
    const file = inside(cache, 'clearwater-release.json');
    const previous = await readJson(file, null);
    try {
        const latest = await metadata(RELEASE, file, signal, {
            refresh: true, validate: value => Boolean(runtimeRelease(value)), timeout: 9000
        });
        return {latest, previous};
    } catch (error) {
        signal.throwIfAborted();
        return {previous, error};
    }
}

function releaseInfo(asset) {
    return {url: asset.browser_download_url, size: asset.size, sha256: asset.digest.slice(7)};
}

function clientVersion(file) {
    const mod = JSON.parse(new Zip(file).readAsText('fabric.mod.json'));
    if (mod.id !== 'clearwater' || mod.depends?.minecraft !== MINECRAFT || typeof mod.version !== 'string') {
        throw new Error(`This Clearwater release requires a different Minecraft version. The launcher supports ${MINECRAFT}.`);
    }
    return mod.version;
}

async function verifiedClient(file, references) {
    for (const reference of references) {
        if (!reference || !/^[a-f0-9]{64}$/i.test(reference.sha256) ||
            !Number.isSafeInteger(reference.size) || reference.size <= 0) continue;
        if (await verifiedFile(file, reference)) return {version: clientVersion(file), info: reference};
    }
}

async function rememberClient(file, previous, info) {
    if (previous?.sha256 === info.sha256 && previous?.size === info.size) return;
    try {
        await saveJson(file, {sha256: info.sha256, size: info.size});
    } catch (error) {
        if (!error.syscall && !fileBusy(error)) throw error;
    }
}

async function installClearwater(profile, cache, release, signal) {
    const target = inside(profile, 'mods/clearwater.jar');
    const recordPath = inside(cache, 'clearwater-installed.json');
    const installed = await readJson(recordPath, null);
    const oldAsset = runtimeRelease(release.previous);
    try {
        if (release.error) throw release.error;
        const asset = runtimeRelease(release.latest);
        const info = releaseInfo(asset);
        let version = (await verifiedClient(target, [info]))?.version;
        if (!version) {
            const downloaded = await ensureFile(cache, `releases/${info.sha256}/${asset.name}`, info, signal);
            version = clientVersion(downloaded);
            await installVerifiedFile(downloaded, target, info, signal);
        }
        await rememberClient(recordPath, installed, info);
        return {version};
    } catch (error) {
        signal.throwIfAborted();
        const fallback = await verifiedClient(target, [installed, oldAsset && releaseInfo(oldAsset)]);
        if (!fallback) throw error;
        await rememberClient(recordPath, installed, fallback.info);
        return {version: fallback.version, updateError: error.message};
    }
}

async function installMods(profile, cache, release, signal) {
    const files = await Promise.all(MODS.map(async ([name, id]) => {
        const mod = await metadata(`https://api.modrinth.com/v2/version/${id}`, inside(cache, `mods/${id}.json`), signal, {
            validate: value => value?.id === id && Array.isArray(value.files) && value.files.length > 0
        });
        const file = mod.files.find(candidate => candidate.primary) || mod.files[0];
        return [name, {...file.hashes, url: file.url, size: file.size}];
    }));

    await pool(files, 3, ([name, info], _index, taskSignal) => ensureFile(profile, 'mods/' + name, info, taskSignal), signal);
    return installClearwater(profile, cache, release, signal);
}

function argFileLine(arg) {
    return '"' + arg.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

async function prepare(root, username, signal, notify) {
    if (!validUsername(username)) throw new Error('Use 3–16 letters, numbers, or underscores for your username.');
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This build requires 64-bit Windows.');
    const profile = inside(root, 'profile');
    const cache = inside(root, 'downloads');
    let lastUpdate = 0;
    let lastStage = '';
    const emit = (stage, label, fraction, detail = '') => {
        const now = Date.now();
        if (stage !== lastStage || now - lastUpdate > 85 || fraction === 1) {
            lastStage = stage;
            lastUpdate = now;
            notify({stage, label, fraction, detail});
        }
    };

    emit('metadata', 'Checking files', 0.02);
    const [{vanilla, fabric}, release] = await Promise.all([
        profiles(cache, signal),
        clientRelease(cache, signal)
    ]);
    const java = await javaExecutable(root, cache, vanilla.javaVersion.majorVersion, signal, emit);
    await fs.mkdir(profile, {recursive: true});

    const assets = inside(cache, 'assets');
    const natives = inside(cache, 'natives');
    await fs.mkdir(natives, {recursive: true});
    const libraries = new Map();
    for (const library of [...vanilla.libraries, ...fabric.libraries]) {
        if (!rulesAllow(library.rules)) continue;
        const info = mavenLibrary(library);
        libraries.set(info.key, info);
    }

    emit('game', 'Installing Minecraft and Fabric', 0.20);
    const classpath = Array(libraries.size);
    let completed = 0;
    const total = libraries.size + 4;
    const tick = () => emit('game', 'Installing Minecraft and Fabric', 0.20 + 0.25 * (++completed / total), `${completed} of ${total} files`);
    const tasks = [...libraries.values()].map((lib, index) => async taskSignal => {
        classpath[index] = await ensureLibrary(cache, lib, taskSignal);
    });
    let clientJar, indexPath, loggingFile, client;
    tasks.unshift(
        async taskSignal => { clientJar = await ensureFile(cache, `versions/${MINECRAFT}.jar`, vanilla.downloads.client, taskSignal); },
        async taskSignal => { indexPath = await ensureFile(assets, `indexes/${vanilla.assetIndex.id}.json`, vanilla.assetIndex, taskSignal); },
        async taskSignal => { loggingFile = await ensureFile(cache, `logging/${vanilla.logging.client.file.id}`, vanilla.logging.client.file, taskSignal); },
        async taskSignal => { client = await installMods(profile, cache, release, taskSignal); }
    );
    await pool(tasks, 16, async (task, _index, taskSignal) => { await task(taskSignal); tick(); }, signal);

    const index = await readJson(indexPath, null);
    if (!index?.objects) throw new Error('Invalid Minecraft asset index.');
    const objects = Array.from(new Map(Object.values(index.objects).map(object => [object.hash, object])).values());
    emit('assets', 'Checking game assets', 0.45, `0 of ${objects.length} files`);
    let checked = 0;
    await pool(objects, 32, async ({hash, size}, _index, taskSignal) => {
        if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error('Invalid asset hash.');
        const key = hash.slice(0, 2) + '/' + hash;
        await ensureFile(assets, 'objects/' + key, {
            url: 'https://resources.download.minecraft.net/' + key, sha1: hash, size
        }, taskSignal);
        emit('assets', 'Checking game assets', 0.45 + 0.54 * (++checked / objects.length), `${checked} of ${objects.length} files`);
    }, signal);

    const values = {
        auth_player_name: username, version_name: fabric.id, game_directory: profile,
        assets_root: assets, assets_index_name: vanilla.assetIndex.id, auth_uuid: offlineUuid(username),
        auth_access_token: '0', clientid: '', auth_xuid: '', version_type: 'release',
        natives_directory: natives, launcher_name: 'Clearwater', launcher_version: LAUNCHER_VERSION,
        classpath: [...classpath, clientJar].join(path.delimiter)
    };
    const memory = Math.max(2048, Math.min(4096, Math.floor(os.totalmem() / 2 / 1024 ** 2)));
    const args = [
        '-Xms512M', `-Xmx${memory}M`,
        ...expandArgs(vanilla.arguments.jvm, values),
        ...expandArgs(fabric.arguments.jvm, values),
        vanilla.logging.client.argument.replace('${path}', loggingFile),
        fabric.mainClass,
        ...expandArgs(vanilla.arguments.game, values),
        ...expandArgs(fabric.arguments.game, values)
    ];
    const argsPath = inside(cache, 'launch.args');
    signal.throwIfAborted();
    await fs.writeFile(argsPath, args.map(argFileLine).join('\n') + '\n', 'utf8');
    emit('launch', 'Starting Minecraft', 1);
    return {java, argsPath, profile, clientVersion: client.version, updateError: client.updateError};
}

module.exports = {MINECRAFT, LOADER, offlineUuid, prepare, validUsername};
