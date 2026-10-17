const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getFormattedHwid } = require('./hwid');

const APPDATA = process.env.APPDATA || (process.platform === 'darwin' ? path.join(process.env.HOME, 'Library', 'Preferences') : path.join(process.env.HOME, '.config'));
const SHARED_DATA_DIR = path.join(APPDATA, 'FivestarToolkit', 'data');
const LOCAL_DATA_DIR = path.join(__dirname, '..', 'data');

// Primary data dir: SHARED_DATA_DIR (guarantees Discord bot and Desktop app share the exact same key database)
const DATA_DIR = SHARED_DATA_DIR;
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const LICENSE_FILE = path.join(DATA_DIR, 'license.json');

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(LOCAL_DATA_DIR)) {
        try { fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true }); } catch (_) {}
    }

    // Migrate from local keys.json if shared doesn't exist yet
    const localKeys = path.join(LOCAL_DATA_DIR, 'keys.json');
    if (!fs.existsSync(KEYS_FILE) && fs.existsSync(localKeys)) {
        try {
            fs.copyFileSync(localKeys, KEYS_FILE);
        } catch (_) {}
    }

    if (!fs.existsSync(KEYS_FILE)) {
        // Pre-seed with default developer key
        const initialKeys = [
            {
                key: 'FIVESTAR-OWNER-LIFETIME-DEV',
                status: 'active',
                duration: 'lifetime',
                createdAt: new Date().toISOString(),
                expiresAt: null,
                createdBy: 'system',
                hwid: null,
                note: 'Fivestar Master Developer Lifetime Key'
            },
            {
                key: 'KOUPE-OWNER-LIFETIME-DEV',
                status: 'active',
                duration: 'lifetime',
                createdAt: new Date().toISOString(),
                expiresAt: null,
                createdBy: 'system',
                hwid: null,
                note: 'Legacy Master Key'
            }
        ];
        fs.writeFileSync(KEYS_FILE, JSON.stringify(initialKeys, null, 2), 'utf8');
        try { fs.writeFileSync(localKeys, JSON.stringify(initialKeys, null, 2), 'utf8'); } catch (_) {}
    }
}

const http = require('http');
const https = require('https');

function requestJson(urlStr, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            const parsed = new URL(urlStr);
            const clientLib = parsed.protocol === 'https:' ? https : http;
            const dataStr = options.body ? JSON.stringify(options.body) : null;

            const req = clientLib.request(parsed, {
                method: options.method || 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    ...(dataStr ? { 'Content-Length': Buffer.byteLength(dataStr) } : {})
                },
                timeout: 4000
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try { resolve({ status: res.statusCode, data: data ? JSON.parse(data) : {} }); }
                    catch (_) { resolve({ status: res.statusCode, data: {} }); }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Central auth server request timed out'));
            });

            if (dataStr) req.write(dataStr);
            req.end();
        } catch (e) {
            reject(e);
        }
    });
}

function loadKeys() {
    ensureDataDir();
    try {
        const raw = fs.readFileSync(KEYS_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        try {
            const rawLocal = fs.readFileSync(path.join(LOCAL_DATA_DIR, 'keys.json'), 'utf8');
            return JSON.parse(rawLocal);
        } catch (_) {
            return [];
        }
    }
}

function saveKeys(keys) {
    ensureDataDir();
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8');
    // Mirror to local data dir as well
    try {
        fs.writeFileSync(path.join(LOCAL_DATA_DIR, 'keys.json'), JSON.stringify(keys, null, 2), 'utf8');
    } catch (_) {}
}

function generateKeyString(prefix = 'FIVESTAR') {
    const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const part3 = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `${prefix}-${part1}-${part2}-${part3}`;
}

function calculateExpiry(duration) {
    if (!duration || duration === 'lifetime') return null;
    const now = new Date();
    if (duration === '30d') {
        now.setDate(now.getDate() + 30);
    } else if (duration === '7d') {
        now.setDate(now.getDate() + 7);
    } else if (duration === '1d') {
        now.setDate(now.getDate() + 1);
    } else if (typeof duration === 'number') {
        now.setDate(now.getDate() + duration);
    }
    return now.toISOString();
}

class KeyManager {
    constructor() {
        ensureDataDir();
    }

    createKey(options = {}) {
        const duration = options.duration || 'lifetime';
        const note = options.note || '';
        const createdBy = options.createdBy || 'owner';
        const claimedBy = options.claimedBy || null;

        const keyStr = generateKeyString(options.prefix || 'FIVESTAR');
        const expiresAt = calculateExpiry(duration);

        const newKey = {
            key: keyStr,
            status: 'active',
            duration: duration,
            createdAt: new Date().toISOString(),
            expiresAt: expiresAt,
            createdBy: createdBy,
            claimedBy: claimedBy,
            hwid: null,
            note: note,
            lastUsed: null
        };

        const keys = loadKeys();
        keys.push(newKey);
        saveKeys(keys);

        return newKey;
    }

    getAllKeys() {
        return loadKeys();
    }

    getKey(keyStr) {
        if (!keyStr) return null;
        const keys = loadKeys();
        const norm = keyStr.trim().toUpperCase();
        return keys.find(k => k.key.toUpperCase() === norm) || null;
    }

    validateKey(keyStr, targetHwid = null) {
        const keyData = this.getKey(keyStr);
        if (!keyData) {
            return { valid: false, reason: 'Key does not exist' };
        }

        if (keyData.status === 'revoked') {
            return { valid: false, reason: 'Key has been revoked by owner' };
        }

        if (keyData.expiresAt) {
            const exp = new Date(keyData.expiresAt);
            if (exp < new Date()) {
                keyData.status = 'expired';
                this.updateKey(keyData);
                return { valid: false, reason: 'Key has expired' };
            }
        }

        const hwid = targetHwid || getFormattedHwid();
        if (keyData.hwid && keyData.hwid !== hwid) {
            return { valid: false, reason: `HWID mismatch. Locked to ${keyData.hwid}` };
        }

        return { valid: true, keyData };
    }

    activateKey(keyStr, targetHwid = null, machineInfo = {}) {
        const hwid = targetHwid || getFormattedHwid();
        const val = this.validateKey(keyStr, hwid);
        if (!val.valid && !val.reason.includes('HWID mismatch')) {
            return { success: false, message: val.reason };
        }

        const keys = loadKeys();
        const norm = keyStr.trim().toUpperCase();
        const keyIndex = keys.findIndex(k => k.key.toUpperCase() === norm);
        if (keyIndex === -1) return { success: false, message: 'Key not found' };

        const k = keys[keyIndex];
        if (k.hwid && k.hwid !== hwid) {
            return { success: false, message: `Key locked to another machine HWID (${k.hwid})` };
        }

        k.hwid = hwid;
        k.lastUsed = new Date().toISOString();
        if (machineInfo.os) k.machineOs = machineInfo.os;
        if (machineInfo.name) k.machineName = machineInfo.name;

        keys[keyIndex] = k;
        saveKeys(keys);

        // Save local license file in both shared and local directories
        const licenseData = {
            key: k.key,
            hwid: hwid,
            duration: k.duration,
            expiresAt: k.expiresAt,
            activatedAt: new Date().toISOString()
        };
        fs.writeFileSync(LICENSE_FILE, JSON.stringify(licenseData, null, 2), 'utf8');
        try {
            fs.writeFileSync(path.join(LOCAL_DATA_DIR, 'license.json'), JSON.stringify(licenseData, null, 2), 'utf8');
        } catch (_) {}

        return { success: true, message: 'License activated successfully', keyData: k };
    }

    getLocalLicense() {
        const filesToCheck = [LICENSE_FILE, path.join(LOCAL_DATA_DIR, 'license.json')];
        for (const file of filesToCheck) {
            if (!fs.existsSync(file)) continue;
            try {
                const raw = fs.readFileSync(file, 'utf8');
                const lic = JSON.parse(raw);
                const currentHwid = getFormattedHwid();
                if (lic.hwid && lic.hwid !== currentHwid) {
                    continue;
                }
                const val = this.validateKey(lic.key, currentHwid);
                if (!val.valid) {
                    // If key is revoked or expired, delete stale license file immediately!
                    try { fs.unlinkSync(file); } catch (_) {}
                    return null;
                }
                return { ...lic, keyData: val.keyData };
            } catch (_) {}
        }
        return null;
    }

    deactivateLocalLicense() {
        const filesToCheck = [LICENSE_FILE, path.join(LOCAL_DATA_DIR, 'license.json')];
        for (const file of filesToCheck) {
            if (fs.existsSync(file)) {
                try { fs.unlinkSync(file); } catch (_) {}
            }
        }
        return true;
    }

    revokeKey(keyStr) {
        const keys = loadKeys();
        const norm = keyStr.trim().toUpperCase();
        const k = keys.find(k => k.key.toUpperCase() === norm);
        if (!k) return false;

        k.status = 'revoked';
        k.revokedAt = new Date().toISOString();
        saveKeys(keys);

        // Clear local license in both locations immediately
        const localLic = path.join(LOCAL_DATA_DIR, 'license.json');
        for (const f of [LICENSE_FILE, localLic]) {
            if (fs.existsSync(f)) {
                try {
                    const lic = JSON.parse(fs.readFileSync(f, 'utf8'));
                    if (lic.key && lic.key.toUpperCase() === norm) {
                        fs.unlinkSync(f);
                    }
                } catch (_) {}
            }
        }

        return true;
    }

    resetHwid(keyStr) {
        const keys = loadKeys();
        const norm = keyStr.trim().toUpperCase();
        const k = keys.find(k => k.key.toUpperCase() === norm);
        if (!k) return false;

        k.hwid = null;
        k.lastReset = new Date().toISOString();
        saveKeys(keys);
        return true;
    }

    updateKey(updatedKey) {
        const keys = loadKeys();
        const idx = keys.findIndex(k => k.key === updatedKey.key);
        if (idx !== -1) {
            keys[idx] = updatedKey;
            saveKeys(keys);
        }
    }

    deleteKey(keyStr) {
        let keys = loadKeys();
        const norm = keyStr.trim().toUpperCase();
        keys = keys.filter(k => k.key.toUpperCase() !== norm);
        saveKeys(keys);
        return true;
    }

    getAuthConfig() {
        try {
            const authPath = path.join(__dirname, '..', 'config', 'auth.json');
            if (fs.existsSync(authPath)) {
                return JSON.parse(fs.readFileSync(authPath, 'utf8'));
            }
        } catch (_) {}
        return { authServerUrl: '', cloudAuthEnabled: false };
    }

    async validateKeyRemote(keyStr, targetHwid = null) {
        const authCfg = this.getAuthConfig();
        if (authCfg.cloudAuthEnabled && authCfg.authServerUrl) {
            try {
                const hwid = targetHwid || getFormattedHwid();
                const cleanBase = authCfg.authServerUrl.replace(/\/+$/, '');
                const targetUrl = `${cleanBase}/api/v1/license/validate?key=${encodeURIComponent(keyStr)}&hwid=${encodeURIComponent(hwid)}`;
                const res = await requestJson(targetUrl);
                if (res.data && res.data.valid !== undefined) {
                    return res.data;
                }
            } catch (err) {
                // Server offline or network issue, fallback to local
            }
        }
        return this.validateKey(keyStr, targetHwid);
    }

    async activateKeyRemote(keyStr, targetHwid = null, machineInfo = {}) {
        const authCfg = this.getAuthConfig();
        if (authCfg.cloudAuthEnabled && authCfg.authServerUrl) {
            try {
                const hwid = targetHwid || getFormattedHwid();
                const cleanBase = authCfg.authServerUrl.replace(/\/+$/, '');
                const targetUrl = `${cleanBase}/api/v1/license/activate`;
                const res = await requestJson(targetUrl, {
                    method: 'POST',
                    body: { key: keyStr, hwid, machineInfo }
                });

                if (res.data && res.data.success) {
                    const licenseData = {
                        key: keyStr.toUpperCase(),
                        hwid: hwid,
                        duration: (res.data.keyData && res.data.keyData.duration) || 'lifetime',
                        expiresAt: (res.data.keyData && res.data.keyData.expiresAt) || null,
                        activatedAt: new Date().toISOString()
                    };
                    fs.writeFileSync(LICENSE_FILE, JSON.stringify(licenseData, null, 2), 'utf8');
                    try {
                        fs.writeFileSync(path.join(LOCAL_DATA_DIR, 'license.json'), JSON.stringify(licenseData, null, 2), 'utf8');
                    } catch (_) {}
                    return res.data;
                } else if (res.data && res.data.message) {
                    return res.data;
                }
            } catch (err) {
                // Server offline or network issue, fallback to local
            }
        }
        return this.activateKey(keyStr, targetHwid, machineInfo);
    }
}

module.exports = new KeyManager();
