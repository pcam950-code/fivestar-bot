const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { execSync } = require('child_process');

function getWindowsMachineGuid() {
    if (process.platform !== 'win32') return null;
    try {
        const out = execSync('REG QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true
        });
        const match = out.match(/REG_SZ\s+([A-Fa-f0-9\-]+)/);
        if (match && match[1]) {
            return match[1].trim().toLowerCase();
        }
    } catch (_) {}
    return null;
}

function getRawHwid() {
    const guid = getWindowsMachineGuid();
    if (guid) {
        return crypto.createHash('sha256').update(guid).digest('hex');
    }

    // Fallback: stable hash of cpu info, network macs, and user info
    const net = os.networkInterfaces();
    const macs = [];
    for (const iface of Object.values(net)) {
        if (!iface) continue;
        for (const alias of iface) {
            if (alias.mac && alias.mac !== '00:00:00:00:00:00') {
                macs.push(alias.mac);
            }
        }
    }
    const cpus = os.cpus().map(c => c.model).join(',');
    const hostname = os.hostname();
    const raw = `${macs.sort().join(';')}|${cpus}|${hostname}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
}

function getFormattedHwid() {
    const raw = getRawHwid();
    const hash = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
    return `${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}`;
}

module.exports = {
    getRawHwid,
    getFormattedHwid
};
