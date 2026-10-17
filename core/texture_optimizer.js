const fs = require('fs');
const path = require('path');
const { ResourceData, Dictionary, Texture, Drawable, FragType } = require('../rage/RageLib');

const STREAM_LIMIT_BYTES = 16 * 1024 * 1024; // 16 MB FiveM texture budget limit

class TextureOptimizer {
    constructor(options = {}) {
        this.baseDir = options.baseDir || path.resolve(__dirname, '..');
    }

    /**
     * Scans a directory for all texture assets:
     * - Standalone .ytd (Texture Dictionaries)
     * - Embedded textures inside .ydr (Drawables) and .yft (Fragments)
     * - Loose .dds files
     * @param {string} targetDir 
     */
    scanTextures(targetDir) {
        const streamDir = fs.existsSync(path.join(targetDir, 'stream')) ? path.join(targetDir, 'stream') : targetDir;
        if (!fs.existsSync(streamDir)) {
            return {
                streamDir,
                ytdFiles: [],
                embeddedModels: [],
                ddsFiles: [],
                totalTexturesCount: 0,
                totalSizeMB: '0.00',
                totalGpuVramMB: '0.00',
                oversizedCount: 0
            };
        }

        const ytdFiles = [];
        const embeddedModels = [];
        const ddsFiles = [];
        let totalDiskBytes = 0;
        let totalGpuBytes = 0;
        let totalTexturesCount = 0;
        let oversizedCount = 0;

        const files = fs.readdirSync(streamDir);
        for (const file of files) {
            const fullPath = path.join(streamDir, file);
            const lower = file.toLowerCase();
            const stat = fs.statSync(fullPath);

            // 1. Standalone .ytd Texture Dictionaries
            if (lower.endsWith('.ytd')) {
                totalDiskBytes += stat.size;
                const isOversized = stat.size > STREAM_LIMIT_BYTES;
                if (isOversized) oversizedCount++;

                let details = null;
                try {
                    const rd = new ResourceData(fullPath);
                    if (rd.m_bLoaded) {
                        totalGpuBytes += rd.m_dwGpuDataSize;
                        const dict = new Dictionary(rd.getData(), 0, rd, Texture);
                        const textures = [];
                        for (const t of (dict.m_data?.items || [])) {
                            if (t) {
                                textures.push({
                                    name: t.m_pszName || 'unnamed',
                                    width: t.m_wWidth,
                                    height: t.m_wHeight,
                                    format: t.pixelFormat,
                                    mips: t.m_nbLevels,
                                    usage: t.usageType
                                });
                            }
                        }
                        totalTexturesCount += textures.length;
                        details = {
                            textureCount: textures.length,
                            textures,
                            cpuSize: rd.m_dwCpuDataSize,
                            gpuSize: rd.m_dwGpuDataSize,
                            gpuSizeMB: (rd.m_dwGpuDataSize / (1024 * 1024)).toFixed(2)
                        };
                    }
                } catch (_) {}

                ytdFiles.push({
                    file,
                    path: fullPath,
                    size: stat.size,
                    sizeMB: (stat.size / (1024 * 1024)).toFixed(2),
                    isOversized,
                    details
                });
            }

            // 2. Embedded Textures inside 3D Models (.ydr, .yft)
            else if (lower.endsWith('.ydr') || lower.endsWith('.yft')) {
                totalDiskBytes += stat.size;
                try {
                    const rd = new ResourceData(fullPath);
                    if (rd.m_bLoaded) {
                        let txdDict = null;
                        if (lower.endsWith('.ydr')) {
                            const drawable = new Drawable(rd.getData(), 0, rd);
                            txdDict = drawable.m_pShaderGroup?.m_pTxd;
                        } else if (lower.endsWith('.yft')) {
                            const frag = new FragType(rd.getData(), 0, rd);
                            txdDict = frag.m_pDrawable?.m_pShaderGroup?.m_pTxd;
                        }

                        if (txdDict && txdDict.m_data?.items?.length > 0) {
                            totalGpuBytes += rd.m_dwGpuDataSize;
                            const textures = [];
                            let hasHighRes = false;

                            for (const t of txdDict.m_data.items) {
                                if (t) {
                                    if (t.m_wWidth > 1024 || t.m_wHeight > 1024) hasHighRes = true;
                                    textures.push({
                                        name: t.m_pszName || 'unnamed',
                                        width: t.m_wWidth,
                                        height: t.m_wHeight,
                                        format: t.pixelFormat,
                                        mips: t.m_nbLevels,
                                        usage: t.usageType
                                    });
                                }
                            }

                            totalTexturesCount += textures.length;
                            const isModelOversized = stat.size > STREAM_LIMIT_BYTES || rd.m_dwGpuDataSize > (20 * 1024 * 1024);
                            if (isModelOversized) oversizedCount++;

                            embeddedModels.push({
                                file,
                                path: fullPath,
                                type: lower.endsWith('.ydr') ? 'Drawable (.ydr)' : 'Fragment (.yft)',
                                size: stat.size,
                                sizeMB: (stat.size / (1024 * 1024)).toFixed(2),
                                gpuSize: rd.m_dwGpuDataSize,
                                gpuSizeMB: (rd.m_dwGpuDataSize / (1024 * 1024)).toFixed(2),
                                isOversized: isModelOversized,
                                hasHighRes,
                                textureCount: textures.length,
                                textures
                            });
                        }
                    }
                } catch (_) {}
            }

            // 3. Loose .dds Textures
            else if (lower.endsWith('.dds')) {
                totalDiskBytes += stat.size;
                totalTexturesCount++;
                ddsFiles.push({
                    file,
                    path: fullPath,
                    size: stat.size,
                    sizeMB: (stat.size / (1024 * 1024)).toFixed(2)
                });
            }
        }

        return {
            streamDir,
            ytdFiles,
            embeddedModels,
            ddsFiles,
            totalTexturesCount,
            totalDiskBytes,
            totalSizeMB: (totalDiskBytes / (1024 * 1024)).toFixed(2),
            totalGpuBytes,
            totalGpuVramMB: (totalGpuBytes / (1024 * 1024)).toFixed(2),
            oversizedCount
        };
    }

    /**
     * Optimizes all textures in a target resource (both .ytd dictionaries and embedded model textures).
     * @param {string} targetDir 
     * @param {Object} options
     * @param {number} [options.maxResolution=2048] - Max width/height allowed
     * @param {boolean} [options.onlyOversized=false] - Only optimize assets exceeding budget limits
     * @param {Function} [options.onLog]
     */
    async optimizeResource(targetDir, options = {}) {
        const {
            maxResolution = 2048,
            onlyOversized = false,
            onLog = console.log
        } = options;

        const scan = this.scanTextures(targetDir);
        const results = {
            processed: 0,
            optimized: 0,
            bytesSaved: 0,
            files: []
        };

        onLog(`[TEXTURE] Found ${scan.ytdFiles.length} .ytd dictionaries, ${scan.embeddedModels.length} models with embedded textures (${scan.totalTexturesCount} total textures, ${scan.totalGpuVramMB} MB VRAM)`);

        // Helper to optimize textures inside a dictionary
        const optimizeTxd = (txdDict, fileLabel) => {
            let modified = 0;
            if (!txdDict?.m_data?.items) return 0;

            for (const t of txdDict.m_data.items) {
                if (!t) continue;
                if ((t.m_wWidth > maxResolution || t.m_wHeight > maxResolution) && t.m_nbLevels > 1) {
                    t.m_wWidth = Math.max(4, Math.floor(t.m_wWidth / 2));
                    t.m_wHeight = Math.max(4, Math.floor(t.m_wHeight / 2));
                    t.m_nbLevels = Math.max(1, t.m_nbLevels - 1);
                    modified++;
                }
            }
            return modified;
        };

        // 1. Process Standalone .ytd files
        for (const ytd of scan.ytdFiles) {
            if (onlyOversized && !ytd.isOversized) continue;
            results.processed++;
            onLog(`[TEXTURE] Optimizing .ytd: ${ytd.file} (${ytd.sizeMB} MB)...`);

            try {
                const rd = new ResourceData(ytd.path);
                if (!rd.m_bLoaded) continue;

                const dict = new Dictionary(rd.getData(), 0, rd, Texture);
                const modifiedCount = optimizeTxd(dict, ytd.file);

                if (modifiedCount > 0) {
                    const tempOut = ytd.path + '.opt_tmp';
                    rd.saveNewFile(tempOut);
                    const newStat = fs.statSync(tempOut);
                    const saved = ytd.size - newStat.size;

                    fs.copyFileSync(tempOut, ytd.path);
                    try { fs.unlinkSync(tempOut); } catch (_) {}

                    results.optimized++;
                    results.bytesSaved += Math.max(0, saved);
                    results.files.push({
                        file: ytd.file,
                        type: '.ytd',
                        texturesModified: modifiedCount,
                        oldSize: ytd.size,
                        newSize: newStat.size,
                        savedBytes: saved
                    });

                    onLog(`[TEXTURE] ✓ ${ytd.file}: Downscaled ${modifiedCount} textures. Saved ${(saved / (1024 * 1024)).toFixed(2)} MB`);
                }
            } catch (err) {
                onLog(`[TEXTURE] ⚠️ Error optimizing ${ytd.file}: ${err.message}`);
            }
        }

        // 2. Process Embedded Textures inside .ydr / .yft models
        for (const model of scan.embeddedModels) {
            if (onlyOversized && !model.isOversized) continue;
            results.processed++;
            onLog(`[TEXTURE] Optimizing embedded model textures: ${model.file} (${model.sizeMB} MB, ${model.textureCount} textures)...`);

            try {
                const rd = new ResourceData(model.path);
                if (!rd.m_bLoaded) continue;

                let txdDict = null;
                if (model.file.toLowerCase().endsWith('.ydr')) {
                    const drawable = new Drawable(rd.getData(), 0, rd);
                    txdDict = drawable.m_pShaderGroup?.m_pTxd;
                } else if (model.file.toLowerCase().endsWith('.yft')) {
                    const frag = new FragType(rd.getData(), 0, rd);
                    txdDict = frag.m_pDrawable?.m_pShaderGroup?.m_pTxd;
                }

                if (!txdDict) continue;

                const modifiedCount = optimizeTxd(txdDict, model.file);
                if (modifiedCount > 0) {
                    const tempOut = model.path + '.opt_tmp';
                    rd.saveNewFile(tempOut);
                    const newStat = fs.statSync(tempOut);
                    const saved = model.size - newStat.size;

                    fs.copyFileSync(tempOut, model.path);
                    try { fs.unlinkSync(tempOut); } catch (_) {}

                    results.optimized++;
                    results.bytesSaved += Math.max(0, saved);
                    results.files.push({
                        file: model.file,
                        type: 'Embedded 3D Model',
                        texturesModified: modifiedCount,
                        oldSize: model.size,
                        newSize: newStat.size,
                        savedBytes: saved
                    });

                    onLog(`[TEXTURE] ✓ ${model.file}: Downscaled ${modifiedCount} embedded textures. Reduced file by ${(saved / (1024 * 1024)).toFixed(2)} MB`);
                } else {
                    onLog(`[TEXTURE] - ${model.file}: Already optimized within limits.`);
                }
            } catch (err) {
                onLog(`[TEXTURE] ⚠️ Error optimizing embedded textures in ${model.file}: ${err.message}`);
            }
        }

        onLog(`[TEXTURE] Complete. Optimized ${results.optimized}/${results.processed} files. Total disk/VRAM saved: ${(results.bytesSaved / (1024 * 1024)).toFixed(2)} MB`);
        return results;
    }
}

module.exports = TextureOptimizer;
