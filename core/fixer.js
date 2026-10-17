const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');
const TextureOptimizer = require('./texture_optimizer');

const MODEL_EXTENSIONS = new Set(['.ydr', '.ydd', '.yft']);

class FixerEngine {
    constructor(options = {}) {
        this.baseDir = options.baseDir || path.resolve(__dirname, '..');
        this.binDir = options.binDir || path.join(this.baseDir, 'bin');
        this.rageDir = options.rageDir || path.join(this.baseDir, 'rage');
        this.adhesivePath = options.adhesivePath || path.join(this.binDir, 'adhesive.dll');
        this.workerScript = options.workerScript || path.join(this.binDir, 'fix-worker.js');
        this.maxWorkers = options.maxWorkers || Math.min(os.cpus().length, 4);
        this.textureOptimizer = new TextureOptimizer(options);
    }

    /**
     * Recursively gathers all model files (.ydr, .ydd, .yft) from a directory.
     */
    findModels(dir) {
        const models = [];
        const scan = (current) => {
            if (!fs.existsSync(current)) return;
            const entries = fs.readdirSync(current, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    scan(full);
                } else {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (MODEL_EXTENSIONS.has(ext)) {
                        models.push(full);
                    }
                }
            }
        };
        scan(dir);
        return models;
    }

    /**
     * Runs 3D vertex repair on a set of files or directory.
     * @param {Object} params
     * @param {string} params.inputDir - Source directory
     * @param {string} [params.outputDir] - Destination directory (defaults to in-place inputDir)
     * @param {Array<{input: string, output: string}>} [params.fileList] - Explicit list of file tasks
     * @param {number} [params.workers] - Number of parallel workers
     * @param {Function} [params.onProgress] - Progress callback
     * @param {Function} [params.onLog] - Log message callback
     */
    async fix(params = {}) {
        const {
            inputDir,
            outputDir = inputDir,
            fileList,
            workers = this.maxWorkers,
            optimizeTextures = false,
            maxTextureResolution = 2048,
            onProgress,
            onLog
        } = params;

        let tasks = [];
        if (fileList && fileList.length > 0) {
            tasks = fileList;
        } else if (inputDir) {
            // If outputting to a separate folder, mirror all non-model files (.ymap, .ytyp, .ybn, .ytd, fxmanifest)
            // so the map resource stays 100% complete and working!
            if (path.resolve(outputDir) !== path.resolve(inputDir)) {
                const copyNonModels = (dir) => {
                    if (!fs.existsSync(dir)) return;
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const full = path.join(dir, entry.name);
                        const rel = path.relative(inputDir, full);
                        const dest = path.join(outputDir, rel);
                        if (entry.isDirectory()) {
                            copyNonModels(full);
                        } else {
                            const ext = path.extname(entry.name).toLowerCase();
                            if (!MODEL_EXTENSIONS.has(ext)) {
                                fs.mkdirSync(path.dirname(dest), { recursive: true });
                                fs.copyFileSync(full, dest);
                            }
                        }
                    }
                };
                copyNonModels(inputDir);

                // Ensure fxmanifest.lua registers all .ytyp files and removes escrow lock
                const manifestPath = path.join(outputDir, 'fxmanifest.lua');
                if (fs.existsSync(manifestPath)) {
                    let manifest = fs.readFileSync(manifestPath, 'utf8');
                    manifest = manifest.replace(/dependency\s+['"]\/assetpacks['"]\r?\n?/gi, '');
                    const streamDir = path.join(outputDir, 'stream');
                    if (fs.existsSync(streamDir)) {
                        const ytyps = fs.readdirSync(streamDir).filter(f => f.toLowerCase().endsWith('.ytyp'));
                        for (const ytyp of ytyps) {
                            if (!manifest.includes(ytyp)) {
                                manifest += `\ndata_file 'DLC_ITYP_REQUEST' 'stream/${ytyp}'\n`;
                            }
                        }
                    }
                    fs.writeFileSync(manifestPath, manifest, 'utf8');
                }
            }

            const models = this.findModels(inputDir);
            tasks = models.map(m => ({
                input: m,
                output: path.join(outputDir, path.relative(inputDir, m))
            }));
        }

        if (tasks.length === 0) {
            if (onLog) onLog('No 3D models (.ydr, .ydd, .yft) found to process.');
            return {
                totalModels: 0,
                totalFixedGeometries: 0,
                fixedFiles: 0,
                cleanFiles: 0,
                errorFiles: 0,
                durationSeconds: 0
            };
        }

        const numWorkers = Math.max(1, Math.min(workers, tasks.length));
        const chunkSize = Math.ceil(tasks.length / numWorkers);
        const startTime = Date.now();

        if (onLog) {
            onLog(`Starting 3D Vertex Repair: ${tasks.length} models across ${numWorkers} workers...`);
        }

        let completedFiles = 0;
        let runningFixed = 0;

        const promises = [];

        for (let i = 0; i < numWorkers; i++) {
            const workerFiles = tasks.slice(i * chunkSize, (i + 1) * chunkSize);
            if (workerFiles.length === 0) continue;

            const p = new Promise((resolve) => {
                const child = fork(this.workerScript, [], { silent: true });
                let finished = false;

                const timeout = setTimeout(() => {
                    if (!finished) {
                        if (onLog) onLog(`[Worker ${i}] Timed out after 10 minutes`);
                        try { child.kill(); } catch (_) {}
                    }
                }, 10 * 60 * 1000);

                const finish = (result) => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timeout);
                    child.removeAllListeners();
                    resolve(result);
                };

                child.on('message', (msg) => {
                    if (msg.log && onLog) {
                        onLog(msg.log);
                    }
                    if (msg.type === 'progress') {
                        completedFiles++;
                        runningFixed += msg.totalFixed || 0;
                        if (onProgress) {
                            onProgress({
                                current: completedFiles,
                                total: tasks.length,
                                percent: Math.round((completedFiles / tasks.length) * 100),
                                totalFixed: runningFixed
                            });
                        }
                    }
                    if (msg.done) {
                        finish(msg);
                    }
                });

                child.on('error', (err) => {
                    if (onLog) onLog(`[Worker ${i}] Worker error: ${err.message}`);
                    finish({ fixed: 0, processed: 0, fileResults: [] });
                });

                child.on('exit', () => {
                    finish({ fixed: 0, processed: 0, fileResults: [] });
                });

                // Send payload
                child.send({
                    workerId: i + 1,
                    binPath: this.binDir,
                    ragePath: this.rageDir,
                    adhesivePath: this.adhesivePath,
                    files: workerFiles
                });
            });

            promises.push(p);
        }

        const results = await Promise.all(promises);
        const totalFixedGeometries = results.reduce((acc, r) => acc + (r.fixed || 0), 0);
        const allFileResults = results.flatMap(r => r.fileResults || []);

        const fixedFiles = allFileResults.filter(r => r.status === 'fixed').length;
        const cleanFiles = allFileResults.filter(r => r.status === 'clean').length;
        const errorFiles = allFileResults.filter(r => r.status === 'error' || r.status === 'reverted').length;
        const durationSeconds = Number(((Date.now() - startTime) / 1000).toFixed(2));

        let textureStats = null;
        if (optimizeTextures) {
            if (onLog) onLog(`[FIXER] Optimizing texture dictionaries (.ytd) for VRAM & budget limits...`);
            textureStats = await this.textureOptimizer.optimizeResource(outputDir, {
                maxResolution: maxTextureResolution,
                onLog
            });
        }

        const summary = {
            totalModels: tasks.length,
            totalFixedGeometries,
            fixedFiles,
            cleanFiles,
            errorFiles,
            durationSeconds,
            textureStats,
            details: allFileResults
        };

        if (onLog) {
            onLog(`3D Repair Completed: ${totalFixedGeometries} geometries repaired in ${fixedFiles} files (${durationSeconds}s)`);
        }

        return summary;
    }
}

module.exports = FixerEngine;
