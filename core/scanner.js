const fs = require('fs');
const path = require('path');

const MODEL_EXTENSIONS = new Set(['.ydr', '.ydd', '.yft']);
const TEXTURE_EXTENSIONS = new Set(['.ytd', '.dds']);
const MAP_EXTENSIONS = new Set(['.ymap']);
const COLLISION_EXTENSIONS = new Set(['.ybn']);
const ARCHETYPE_EXTENSIONS = new Set(['.ytyp', '.ymf']);
const AUDIO_EXTENSIONS = new Set(['.awc', '.rel', '.dat']);
const CONFIG_EXTENSIONS = new Set(['.xml', '.meta']);

/**
 * Scans a directory recursively and returns all file paths.
 */
function walkDirectory(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walkDirectory(fullPath, fileList);
            } else {
                fileList.push(fullPath);
            }
        }
    } catch (_) {}
    return fileList;
}

/**
 * Analyzes a single file and extracts its category and metadata.
 */
function analyzeFile(filePath, rootDir) {
    const ext = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath);
    const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
    let size = 0;
    let mtime = null;

    try {
        const stats = fs.statSync(filePath);
        size = stats.size;
        mtime = stats.mtime;
    } catch (_) {}

    let category = 'other';
    if (MODEL_EXTENSIONS.has(ext)) category = 'model';
    else if (TEXTURE_EXTENSIONS.has(ext)) category = 'texture';
    else if (MAP_EXTENSIONS.has(ext)) category = 'map';
    else if (COLLISION_EXTENSIONS.has(ext)) category = 'collision';
    else if (ARCHETYPE_EXTENSIONS.has(ext)) category = 'archetype';
    else if (AUDIO_EXTENSIONS.has(ext)) category = 'audio';
    else if (CONFIG_EXTENSIONS.has(ext)) category = 'metadata';
    else if (basename.toLowerCase() === 'fxmanifest.lua' || basename.toLowerCase() === '__resource.lua') category = 'manifest';

    return {
        name: basename,
        ext,
        category,
        fullPath: path.resolve(filePath),
        relPath,
        size,
        mtime,
        isStreamAsset: relPath.startsWith('stream/') || ext.startsWith('.y')
    };
}

/**
 * Parses an fxmanifest.lua or __resource.lua file and extracts metadata and declared data files.
 */
function parseManifest(manifestPath) {
    if (!fs.existsSync(manifestPath)) return null;

    try {
        const content = fs.readFileSync(manifestPath, 'utf8');
        const lines = content.split(/\r?\n/);

        const manifest = {
            raw: content,
            fxVersion: 'cerulean',
            game: 'gta5',
            name: '',
            author: '',
            description: '',
            version: '1.0.0',
            dataFiles: [], // { type, path }
            files: [],
            dependencies: [],
            hasEscrowNotice: false
        };

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('--') || !trimmed) continue;

            // fx_version
            const fxMatch = trimmed.match(/fx_version\s+['"]([^'"]+)['"]/i);
            if (fxMatch) manifest.fxVersion = fxMatch[1];

            // game
            const gameMatch = trimmed.match(/game\s+['"]([^'"]+)['"]/i);
            if (gameMatch) manifest.game = gameMatch[1];

            // name / author / desc
            const nameMatch = trimmed.match(/name\s+['"]([^'"]+)['"]/i);
            if (nameMatch) manifest.name = nameMatch[1];

            const authorMatch = trimmed.match(/author\s+['"]([^'"]+)['"]/i);
            if (authorMatch) manifest.author = authorMatch[1];

            const descMatch = trimmed.match(/description\s+['"]([^'"]+)['"]/i);
            if (descMatch) manifest.description = descMatch[1];

            // data_file 'TYPE' 'PATH'
            const dfMatch = trimmed.match(/data_file\s+['"]([^'"]+)['"]\s+['"]([^'"]+)['"]/i);
            if (dfMatch) {
                manifest.dataFiles.push({ type: dfMatch[1], file: dfMatch[2] });
            }

            // dependency '/assetpacks'
            if (trimmed.includes("'/assetpacks'") || trimmed.includes('"assetpacks"')) {
                manifest.hasEscrowNotice = true;
            }
        }

        return manifest;
    } catch (_) {
        return null;
    }
}

/**
 * Inspects a folder to determine if it is a single FiveM resource or a collection of resources.
 */
function inspectResource(resourceDir) {
    const resolvedDir = path.resolve(resourceDir);
    if (!fs.existsSync(resolvedDir)) {
        throw new Error(`Directory does not exist: ${resolvedDir}`);
    }

    const allFiles = walkDirectory(resolvedDir);
    const resourceName = path.basename(resolvedDir);

    let manifestFile = null;
    for (const f of allFiles) {
        const base = path.basename(f).toLowerCase();
        if (base === 'fxmanifest.lua' || base === 'resource.lua' || base === '__resource.lua') {
            manifestFile = f;
            break;
        }
    }

    const manifestInfo = manifestFile ? parseManifest(manifestFile) : null;
    const streamDir = path.join(resolvedDir, 'stream');
    const hasStreamDir = fs.existsSync(streamDir);

    const files = allFiles.map(f => analyzeFile(f, resolvedDir));

    const models = files.filter(f => f.category === 'model');
    const textures = files.filter(f => f.category === 'texture');
    const maps = files.filter(f => f.category === 'map');
    const collisions = files.filter(f => f.category === 'collision');
    const archetypes = files.filter(f => f.category === 'archetype');
    const audio = files.filter(f => f.category === 'audio');
    const metadata = files.filter(f => f.category === 'metadata');

    // Warning for texture dictionaries > 16MB (FiveM physical streaming limit)
    const largeTextures = textures.filter(t => t.ext === '.ytd' && t.size > 16 * 1024 * 1024);

    const totalSize = files.reduce((acc, f) => acc + f.size, 0);

    return {
        name: resourceName,
        path: resolvedDir,
        hasManifest: !!manifestFile,
        manifestPath: manifestFile,
        manifestInfo,
        hasStreamDir,
        totalFiles: files.length,
        totalSize,
        models,
        textures,
        maps,
        collisions,
        archetypes,
        audio,
        metadata,
        largeTextures,
        allFiles: files
    };
}

/**
 * Finds all FiveM resources in a root folder (or returns the folder itself if it's already a resource).
 */
function discoverResources(inputPaths) {
    const paths = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
    const resources = [];

    for (const p of paths) {
        const resolved = path.resolve(p);
        if (!fs.existsSync(resolved)) continue;

        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) continue;

        // Check if the directory itself has a stream folder or fxmanifest
        const hasManifest = fs.existsSync(path.join(resolved, 'fxmanifest.lua')) ||
                            fs.existsSync(path.join(resolved, '__resource.lua'));
        const hasStream = fs.existsSync(path.join(resolved, 'stream'));

        if (hasManifest || hasStream) {
            resources.push(inspectResource(resolved));
        } else {
            // Check subdirectories
            let subFound = false;
            try {
                const subdirs = fs.readdirSync(resolved, { withFileTypes: true });
                for (const sub of subdirs) {
                    if (sub.isDirectory()) {
                        const subPath = path.join(resolved, sub.name);
                        const subHasManifest = fs.existsSync(path.join(subPath, 'fxmanifest.lua')) ||
                                               fs.existsSync(path.join(subPath, '__resource.lua'));
                        const subHasStream = fs.existsSync(path.join(subPath, 'stream'));
                        if (subHasManifest || subHasStream) {
                            resources.push(inspectResource(subPath));
                            subFound = true;
                        }
                    }
                }
            } catch (_) {}

            if (!subFound) {
                // Treat the entire folder as a loose asset folder
                resources.push(inspectResource(resolved));
            }
        }
    }

    return resources;
}

module.exports = {
    walkDirectory,
    analyzeFile,
    parseManifest,
    inspectResource,
    discoverResources,
    MODEL_EXTENSIONS,
    TEXTURE_EXTENSIONS,
    MAP_EXTENSIONS,
    COLLISION_EXTENSIONS,
    ARCHETYPE_EXTENSIONS
};
