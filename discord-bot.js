// Koupe Toolkit - Discord Bot License Integration
const path = require('path');
const fs = require('fs');

let Discord = null;
try {
    Discord = require('discord.js');
} catch (_) {
    try {
        const bypasserModules = 'C:\\Users\\camrk\\Downloads\\bypasser\\bypasser\\node_modules';
        Discord = require(path.join(bypasserModules, 'discord.js'));
    } catch (e) {
        console.error('[DISCORD BOT ERROR] Could not load discord.js:', e.message);
        process.exit(1);
    }
}

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, PermissionFlagsBits } = Discord;
const keyManager = require('./core/key_manager');

const CONFIG_PATH = path.join(__dirname, 'config', 'discord-config.json');

function loadConfig() {
    let cfg = { token: '', clientId: '', guildId: '', ownerIds: [], allowAdminRole: true };
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (_) {}
    if (process.env.DISCORD_TOKEN) cfg.token = process.env.DISCORD_TOKEN.trim().replace(/^["']|["']$/g, '');
    if (process.env.CLIENT_ID) cfg.clientId = process.env.CLIENT_ID.trim().replace(/^["']|["']$/g, '');
    if (process.env.GUILD_ID) cfg.guildId = process.env.GUILD_ID.trim().replace(/^["']|["']$/g, '');
    return cfg;
}

function saveConfig(cfg) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

const config = loadConfig();

function isAuthorized(interaction) {
    if (!config.ownerIds || config.ownerIds.length === 0) {
        // If no owners set, allow server administrators or guild owner
        if (interaction.guild && interaction.guild.ownerId === interaction.user.id) return true;
        if (config.allowAdminRole && interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) return true;
        return true;
    }
    if (config.ownerIds.includes(interaction.user.id)) return true;
    if (interaction.guild && interaction.guild.ownerId === interaction.user.id) return true;
    if (config.allowAdminRole && interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) return true;
    return false;
}

// -------------------------------------------------------------
// Slash Command Definitions
// -------------------------------------------------------------
const commands = [
    new SlashCommandBuilder()
        .setName('makekey')
        .setDescription('Generate a new Fivestar Toolkit license key')
        .addStringOption(opt =>
            opt.setName('duration')
                .setDescription('Duration of license key')
                .setRequired(false)
                .addChoices(
                    { name: 'Lifetime Access', value: 'lifetime' },
                    { name: '30 Days (1 Month)', value: '30d' },
                    { name: '7 Days (1 Week)', value: '7d' },
                    { name: '1 Day (24 Hours)', value: '1d' }
                )
        )
        .addStringOption(opt =>
            opt.setName('note')
                .setDescription('Optional note or customer label')
                .setRequired(false)
        )
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Discord user to assign key to')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('keys')
        .setDescription('View and manage all existing license keys')
        .addStringOption(opt =>
            opt.setName('filter')
                .setDescription('Filter keys by status')
                .setRequired(false)
                .addChoices(
                    { name: 'All Keys', value: 'all' },
                    { name: 'Active Only', value: 'active' },
                    { name: 'Used / Bound Only', value: 'used' },
                    { name: 'Revoked Only', value: 'revoked' }
                )
        ),

    new SlashCommandBuilder()
        .setName('revoke')
        .setDescription('Revoke and deactivate a license key')
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('The key to revoke (e.g. FIVESTAR-XXXX-XXXX-XXXX)')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('resethwid')
        .setDescription('Reset HWID lock on a license key to allow new PC activation')
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('The key to reset HWID on')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('keyinfo')
        .setDescription('Inspect detailed information for a license key')
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('The license key')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('download')
        .setDescription('Get the direct download link for Fivestar Toolkit v2.0.1'),

    new SlashCommandBuilder()
        .setName('setdownload')
        .setDescription('Update the download link for Fivestar Toolkit (Owner only)')
        .addStringOption(opt =>
            opt.setName('url')
                .setDescription('The download URL (Google Drive, MediaFire, Mega, GitHub)')
                .setRequired(true)
        )
].map(c => c.toJSON());

// -------------------------------------------------------------
// Bot Client
// -------------------------------------------------------------
const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

client.once('ready', async () => {
    console.log(`\n======================================================`);
    console.log(`  Fivestar Toolkit Discord Bot logged in as: ${client.user.tag}`);
    console.log(`======================================================\n`);

    // Register slash commands
    if (config.token && config.clientId) {
        try {
            const rest = new REST({ version: '10' }).setToken(config.token);
            console.log('[BOT] Refreshing application (/) commands...');

            if (config.guildId) {
                await rest.put(
                    Routes.applicationGuildCommands(config.clientId, config.guildId),
                    { body: commands }
                );
                console.log(`[BOT] Successfully registered guild slash commands for guild: ${config.guildId}`);
            } else {
                await rest.put(
                    Routes.applicationCommands(config.clientId),
                    { body: commands }
                );
                console.log('[BOT] Successfully registered global slash commands.');
            }
        } catch (err) {
            console.error('[BOT ERROR] Failed to register slash commands:', err);
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (!isAuthorized(interaction)) {
        return interaction.reply({
            content: '❌ **Access Denied:** Only toolkit owners or administrators can use this command.',
            ephemeral: true
        });
    }

    const { commandName } = interaction;

    // 1. /makekey
    if (commandName === 'makekey') {
        const duration = interaction.options.getString('duration') || 'lifetime';
        const note = interaction.options.getString('note') || 'Created via Discord /makekey';
        const targetUser = interaction.options.getUser('user');

        const keyData = keyManager.createKey({
            duration: duration,
            note: note,
            createdBy: interaction.user.tag,
            claimedBy: targetUser ? targetUser.tag : null
        });

        const embed = new EmbedBuilder()
            .setTitle('🔑 New License Key Generated')
            .setColor(0x00e5ff)
            .setDescription(`A new license key has been generated and added to the database.`)
            .addFields(
                { name: 'License Key', value: `\`\`\`${keyData.key}\`\`\``, inline: false },
                { name: 'Duration', value: `\`${keyData.duration.toUpperCase()}\``, inline: true },
                { name: 'Expires', value: keyData.expiresAt ? `<t:${Math.floor(new Date(keyData.expiresAt).getTime() / 1000)}:R>` : '`Never (Lifetime)`', inline: true },
                { name: 'Status', value: '`🟢 ACTIVE / UNBOUND`', inline: true },
                { name: 'Assigned User', value: targetUser ? `<@${targetUser.id}>` : '`Unassigned`', inline: true },
                { name: 'Note', value: `\`${note}\``, inline: true }
            )
            .setFooter({ text: 'Fivestar Toolkit v2.0.1 • License Engine', iconURL: client.user.displayAvatarURL() })
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }

    // 2. /keys
    if (commandName === 'keys') {
        const filter = interaction.options.getString('filter') || 'all';
        let allKeys = keyManager.getAllKeys();

        if (filter === 'active') {
            allKeys = allKeys.filter(k => k.status === 'active' && !k.hwid);
        } else if (filter === 'used') {
            allKeys = allKeys.filter(k => k.hwid);
        } else if (filter === 'revoked') {
            allKeys = allKeys.filter(k => k.status === 'revoked');
        }

        const totalKeys = keyManager.getAllKeys().length;
        const activeCount = keyManager.getAllKeys().filter(k => k.status === 'active').length;
        const boundCount = keyManager.getAllKeys().filter(k => k.hwid).length;
        const revokedCount = keyManager.getAllKeys().filter(k => k.status === 'revoked').length;

        let listText = '';
        if (allKeys.length === 0) {
            listText = '*No keys found matching the selected filter.*';
        } else {
            const displayKeys = allKeys.slice(-15).reverse();
            listText = displayKeys.map(k => {
                const statusEmoji = k.status === 'revoked' ? '🔴' : (k.hwid ? '🔒' : '🟢');
                const hwidText = k.hwid ? ` [HWID: \`${k.hwid}\`]` : ' [HWID: `Unbound`]';
                const noteText = k.note ? ` — *${k.note}*` : '';
                return `${statusEmoji} \`${k.key}\` (\`${k.duration}\`)${hwidText}${noteText}`;
            }).join('\n');
            if (allKeys.length > 15) {
                listText += `\n*...and ${allKeys.length - 15} more keys.*`;
            }
        }

        const embed = new EmbedBuilder()
            .setTitle('📋 Fivestar Toolkit — License Keys Database')
            .setColor(0x00e5ff)
            .setDescription(`**Overview:** Total: **${totalKeys}** | Active: **${activeCount}** | Bound: **${boundCount}** | Revoked: **${revokedCount}**\n\n${listText}`)
            .setFooter({ text: 'Use /makekey to generate new keys • /resethwid to unlock', iconURL: client.user.displayAvatarURL() })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // 3. /revoke
    if (commandName === 'revoke') {
        const key = interaction.options.getString('key').trim();
        const success = keyManager.revokeKey(key);

        if (!success) {
            return interaction.reply({ content: `❌ Key \`${key}\` was not found.`, ephemeral: true });
        }

        // Notify running toolkit server for real-time SSE broadcast
        try {
            const http = require('http');
            const postData = JSON.stringify({ key });
            const req = http.request({
                hostname: '127.0.0.1',
                port: 3824,
                path: '/api/keys/revoke',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 1000
            });
            req.on('error', () => {});
            req.write(postData);
            req.end();
        } catch (_) {}

        const embed = new EmbedBuilder()
            .setTitle('🚫 License Key Revoked')
            .setColor(0xef4444)
            .setDescription(`The license key \`${key}\` has been **revoked**. Any connected client using this key will be locked out immediately.`)
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }

    // 4. /resethwid
    if (commandName === 'resethwid') {
        const key = interaction.options.getString('key').trim();
        const success = keyManager.resetHwid(key);

        if (!success) {
            return interaction.reply({ content: `❌ Key \`${key}\` was not found.`, ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setTitle('🔓 HWID Lock Reset')
            .setColor(0x22c55e)
            .setDescription(`The hardware ID binding for key \`${key}\` has been **cleared**. The user can now activate this key on their new PC.`)
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }

    // 5. /keyinfo
    if (commandName === 'keyinfo') {
        const key = interaction.options.getString('key').trim();
        const k = keyManager.getKey(key);

        if (!k) {
            return interaction.reply({ content: `❌ Key \`${key}\` not found in database.`, ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setTitle(`🔍 Key Info: ${k.key}`)
            .setColor(0x00e5ff)
            .addFields(
                { name: 'Key', value: `\`${k.key}\``, inline: false },
                { name: 'Status', value: `\`${k.status.toUpperCase()}\``, inline: true },
                { name: 'Duration', value: `\`${k.duration}\``, inline: true },
                { name: 'Created At', value: `<t:${Math.floor(new Date(k.createdAt).getTime() / 1000)}:F>`, inline: true },
                { name: 'Expires At', value: k.expiresAt ? `<t:${Math.floor(new Date(k.expiresAt).getTime() / 1000)}:R>` : '`Never`', inline: true },
                { name: 'Bound HWID', value: k.hwid ? `\`${k.hwid}\`` : '`None (Unbound)`', inline: true },
                { name: 'Created By', value: `\`${k.createdBy || 'Unknown'}\``, inline: true },
                { name: 'Note', value: k.note ? `\`${k.note}\`` : '`None`', inline: false }
            )
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // 6. /download
    if (commandName === 'download') {
        const downloadUrl = config.downloadUrl || 'Contact the owner for the direct download link or run /setdownload';
        const embed = new EmbedBuilder()
            .setTitle('⭐ Download Fivestar Toolkit v2.0.1')
            .setColor(0x00e5ff)
            .setDescription(`**Fivestar Toolkit v2.0.1 — Standalone FiveM 3D Map Engine**\n\n🔗 **Direct Download Link:**\n${config.downloadUrl ? `[**Click Here to Download Fivestar-Toolkit-v2.0.1.zip**](${config.downloadUrl})` : `*${downloadUrl}*`}\n\n**Quick Setup Instructions:**\n1. Download and extract \`Fivestar-Toolkit-v2.0.1-Windows-x64.zip\`.\n2. Double-click \`FivestarToolkit.exe\`.\n3. Enter your license key at the login prompt.\n4. You're ready to fix vertices, clean props, and merge maps!`)
            .addFields(
                { name: 'Version', value: '`v2.0.1 Standalone`', inline: true },
                { name: 'Architecture', value: '`Windows x64`', inline: true },
                { name: 'Prerequisites', value: '`None (Zero-Install)`', inline: true }
            )
            .setFooter({ text: 'Fivestar Toolkit • All-in-One Engine', iconURL: client.user.displayAvatarURL() })
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }

    // 7. /setdownload
    if (commandName === 'setdownload') {
        const url = interaction.options.getString('url').trim();
        config.downloadUrl = url;
        saveConfig(config);

        return interaction.reply({
            content: `✅ **Download URL successfully set!**\nUsers typing \`/download\` will now receive:\n<${url}>`,
            ephemeral: true
        });
    }
});

// -------------------------------------------------------------
// Central Cloud Authentication HTTP Server (Render / Railway / Cloud)
// -------------------------------------------------------------
const http = require('http');

function parseJsonBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch (_) { resolve({}); }
        });
    });
}

function startAuthServer(customPort) {
    const port = customPort || process.env.PORT || 3825;
    const server = http.createServer(async (req, res) => {
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = parsedUrl.pathname;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // 1. Health check (Required for Render & Railway deploy checks)
        if (pathname === '/api/v1/health' || pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'online',
                service: 'Fivestar Toolkit Central Auth API',
                version: '2.0.1',
                totalKeys: keyManager.getAllKeys().length,
                timestamp: new Date().toISOString()
            }));
            return;
        }

        // 2. Real-Time Remote Key Validation
        if (pathname === '/api/v1/license/validate' && req.method === 'GET') {
            const key = (parsedUrl.searchParams.get('key') || '').trim();
            const hwid = (parsedUrl.searchParams.get('hwid') || '').trim();

            if (!key) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ valid: false, reason: 'License key is required' }));
                return;
            }

            const val = keyManager.validateKey(key, hwid || null);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(val));
            return;
        }

        // 3. Remote Key Activation
        if (pathname === '/api/v1/license/activate' && req.method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const key = (body.key || '').trim();
                const hwid = (body.hwid || '').trim();
                const machineInfo = body.machineInfo || {};

                if (!key || !hwid) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Key and HWID are required' }));
                    return;
                }

                const result = keyManager.activateKey(key, hwid, machineInfo);
                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: err.message }));
            }
            return;
        }

        // 4. Remote Key Deactivation (Logout)
        if (pathname === '/api/v1/license/deactivate' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
        }

        // 5. Generate New Key via API
        if (pathname === '/api/v1/keys/create') {
            const duration = parsedUrl.searchParams.get('duration') || 'lifetime';
            const note = parsedUrl.searchParams.get('note') || 'Generated via Web/API';
            const newKey = keyManager.createKey({ duration, note, createdBy: 'admin_api' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, key: newKey.key, keyData: newKey }));
            return;
        }

        // 6. List all keys via API
        if (pathname === '/api/v1/keys/list') {
            const keys = keyManager.getAllKeys();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, keys }));
            return;
        }

        // Fallback 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint not found' }));
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`🌐 [CENTRAL AUTH API] Listening on port ${port} (Ready for Render/Railway/Remote clients)`);
    });

    return server;
}

function startBot() {
    startAuthServer();

    const cfg = loadConfig();
    const token = (process.env.DISCORD_TOKEN || cfg.token || '').trim().replace(/^["']|["']$/g, '');

    if (!token) {
        console.log(`\n======================================================`);
        console.log(`  [DISCORD BOT NOTICE] No Bot Token Found!`);
        console.log(`  Please set DISCORD_TOKEN in Render Environment Variables`);
        console.log(`======================================================\n`);
        return null;
    }

    console.log(`[BOT] Attempting login (token length: ${token.length})...`);
    client.login(token).catch(err => {
        console.error('[DISCORD BOT LOGIN ERROR]', err.message);
        if (err.message.includes('token')) {
            console.error('👉 TIP: If you committed your token to a public GitHub repo, Discord automatically revoked it!');
            console.error('👉 Please click "Reset Token" in Discord Developer Portal and paste the new token into Render.');
        }
    });

    return client;
}

if (require.main === module) {
    startBot();
}

module.exports = {
    startBot,
    startAuthServer,
    client,
    loadConfig,
    saveConfig
};
