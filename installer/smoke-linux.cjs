const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {prepare} = require('../launcher/src/install.cjs');

async function main() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanwater-'));
    const signal = AbortSignal.timeout(12 * 60 * 1000);
    let stage;
    try {
        const ready = await prepare(root, 'LinuxSmoke', signal, progress => {
            if (stage === progress.stage) return;
            stage = progress.stage;
            console.log(progress.label);
        });
        assert.equal(path.basename(ready.java), 'java');
        assert.ok(ready.clientVersion);
        const args = await fs.readFile(ready.argsPath, 'utf8');
        assert.match(args, /lwjgl[^"\r\n]*natives-linux\.jar/);
        assert.doesNotMatch(args, /natives-windows|HeapDumpPath/);
        const {stdout} = await promisify(execFile)(ready.java, ['--version'], {timeout: 10000});
        assert.match(stdout, /^openjdk 25\b/);
        console.log('Prepared the Linux game profile, verified Java 25 and the Minecraft native libraries.');
    } finally {
        await fs.rm(root, {recursive: true, force: true});
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
