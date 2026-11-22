const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');

const USER_AGENT = 'Clearwater-Launcher/1.0 (+https://github.com/primevxie/cleanwaterjars)';

function inside(root, name) {
    const target = path.resolve(root, name);
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep)
        || path.isAbsolute(relative) || relative.includes(':')) {
        throw new Error('Invalid file path in download metadata.');
    }
    return target;
}

function checksum(source) {
    for (const algorithm of ['sha512', 'sha256', 'sha1']) {
        const value = source[algorithm];
        const length = {sha512: 128, sha256: 64, sha1: 40}[algorithm];
        if (typeof value === 'string' && value.length === length && /^[a-f0-9]+$/i.test(value)) {
            return {algorithm, value: value.toLowerCase()};
        }
    }
    throw new Error('Download metadata did not include a supported checksum.');
}

async function request(url, signal, consume, timeout = 60_000) {
    if (new URL(url).protocol !== 'https:') throw new Error('Downloads require HTTPS.');
    for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
            const response = await fetch(url, {
                headers: {'User-Agent': USER_AGENT},
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
            });
            if (!response.ok || new URL(response.url).protocol !== 'https:') {
                await response.body?.cancel();
                const error = new Error(`Download from ${new URL(url).hostname} returned HTTP ${response.status}.`);
                error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
                throw error;
            }
            return await consume(response);
        } catch (error) {
            signal?.throwIfAborted();
            if (attempt >= 2 || error.retryable === false) throw error;
            await delay(450 * 2 ** attempt, undefined, {signal});
        }
    }
}

async function readJson(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
        throw error;
    }
}

async function saveJson(file, value) {
    await fsp.mkdir(path.dirname(file), {recursive: true});
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
        await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
        await fsp.rename(temporary, file);
    } finally {
        await fsp.rm(temporary, {force: true});
    }
}

async function metadata(url, file, signal, {refresh = false, validate = () => true} = {}) {
    const cached = await readJson(file, null);
    const usable = cached && validate(cached);
    if (usable && !refresh) return cached;
    let value;
    try {
        value = await request(url, signal, response => response.json());
    } catch (error) {
        signal?.throwIfAborted();
        if (usable) return cached;
        throw error;
    }
    if (!validate(value)) throw new Error(`Unexpected metadata from ${new URL(url).hostname}.`);
    await saveJson(file, value);
    return value;
}

async function matches(file, expected, size) {
    try {
        const stat = await fsp.stat(file);
        if (!stat.isFile() || (size != null && size !== stat.size)) return false;
        const hash = createHash(expected.algorithm);
        for await (const data of fs.createReadStream(file)) hash.update(data);
        return hash.digest('hex') === expected.value;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

async function ensureFile(root, name, {url, size, ...hashes}, signal, progress) {
    signal?.throwIfAborted();
    const file = inside(root, name);
    const expected = checksum(hashes);
    if (await matches(file, expected, size)) return file;
    await fsp.mkdir(path.dirname(file), {recursive: true});
    const temporary = file + '.part';
    try {
        await request(url, signal, async response => {
            const hash = createHash(expected.algorithm);
            let received = 0;
            const verify = new Transform({
                transform(chunk, _encoding, callback) {
                    received += chunk.length;
                    if (size != null && received > size) {
                        callback(new Error(`Unexpected download size for ${path.basename(file)}.`));
                        return;
                    }
                    hash.update(chunk);
                    progress?.(received, size);
                    callback(null, chunk);
                }
            });
            await pipeline(Readable.fromWeb(response.body), verify, fs.createWriteStream(temporary), {signal});
            if (hash.digest('hex') !== expected.value || (size != null && size !== received)) {
                throw new Error(`Checksum verification failed for ${path.basename(file)}.`);
            }
        }, 300_000);
        await fsp.rename(temporary, file);
        return file;
    } finally {
        await fsp.rm(temporary, {force: true});
    }
}

async function pool(items, limit, work, signal) {
    const batch = new AbortController();
    const combined = signal ? AbortSignal.any([signal, batch.signal]) : batch.signal;
    let next = 0;
    let failure;
    const workers = Array.from({length: Math.min(items.length, limit)}, async () => {
        while (!combined.aborted && next < items.length) {
            const index = next++;
            try {
                await work(items[index], index, combined);
            } catch (error) {
                failure ??= error;
                batch.abort();
            }
        }
    });
    await Promise.all(workers);
    signal?.throwIfAborted();
    if (failure) throw failure;
}

module.exports = {ensureFile, inside, metadata, pool, readJson, request, saveJson};
