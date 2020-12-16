const child_process = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cache = require('@actions/cache');
const core = require('@actions/core');
const exec = require('@actions/exec');
const github = require('@actions/github');
const tr = require('@actions/exec/lib/toolrunner');

function hashString(content) {
    const sha256 = crypto.createHash('sha256');
    return sha256.update(content).digest('hex');
}

function getPythonVersion() {
    const args = ['-c', 'import sys;print(sys.executable+"\\n"+sys.version)'];
    const res = child_process.spawnSync('python', args);
    if (res.status !== 0) {
        throw 'python version check failed';
    }
    return res.stdout.toString();
}

function hashFile(filePath) {
    return hashString(fs.readFileSync(filePath).toString());
}

function addToken(url, token) {
    return url.replace(/^https:\/\//, `https://x-access-token:${token}@`);
}

async function main() {
    await core.group('install pre-commit', async () => {
        await exec.exec('pip', ['install', 'pre-commit']);
        await exec.exec('pip', ['freeze', '--local']);
    });

    const configPath = core.getInput('config');
    const args = [
        'run',
        '--show-diff-on-failure',
        '--color=always',
        `--config=${configPath}`,
        ...tr.argStringToArray(core.getInput('extra_args')),
    ];
    const token = core.getInput('token');
    const pr = github.context.payload.pull_request;
    const push = !!token && !!pr;

    const cachePaths = [path.join(os.homedir(), '.cache', 'pre-commit')];
    const py = getPythonVersion();
    const cacheKey = `pre-commit-2-${hashString(py)}-${hashFile(configPath)}`;
    const restored = await cache.restoreCache(cachePaths, cacheKey);
    const ret = await exec.exec('pre-commit', args, {ignoreReturnCode: push});
    if (!restored) {
        await cache.saveCache(cachePaths, cacheKey);
    }

    if (ret && push) {
        // actions do not run on pushes made by actions.
        // need to make absolute sure things are good before pushing
        // TODO: is there a better way around this limitation?
        await exec.exec('pre-commit', args);

        const diff = await exec.exec(
            'git', ['diff', '--quiet'], {ignoreReturnCode: true}
        );
        if (diff) {
            await core.group('push fixes', async () => {
                await exec.exec('git', ['config', 'user.name', 'pre-commit']);
                await exec.exec(
                    'git', ['config', 'user.email', 'pre-commit@example.com']
                );

                const branch = pr.head.ref;
                await exec.exec('git', ['checkout', 'HEAD', '-b', branch]);

                await exec.exec('git', ['commit', '-am', 'pre-commit fixes']);
                const url = addToken(pr.head.repo.clone_url, token);
                await exec.exec('git', ['push', url, 'HEAD']);
            });
        }
    }
}

main().catch((e) => core.setFailed(e.message));
