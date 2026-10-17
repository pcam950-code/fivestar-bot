const fs = require('fs');
const path = require('path');
const { discoverResources, walkDirectory } = require('./scanner');
const { detectCollisions, resolveCollisions } = require('./conflict_resolver');
const FixerEngine = require('./fixer');
const PropCleaner = require('./prop_cleaner');
const TextureOptimizer = require('./texture_optimizer');

class MapMerger {
    constructor(options = {}) {
        this.baseDir = options.baseDir || path.resolve(__dirname, '..');
        this.fixer = new FixerEngine(options);
        this.cleaner = new PropCleaner();
        this.textureOptimizer = new TextureOptimizer(options);
    }

    /**
     * Executes the full map merge pipeline.
     */
    async merge(params = {}) {
        const {
            inputs, // array of resource folder paths or parent folder
            outputDir, // destination resource folder (e.g. ./merged_maps)
            resourceName = path.basename(outputDir) || 'merged_maps',
            conflictStrategy = 'keep_newest', // 'keep_newest', 'keep_largest', 'prefix', 'overwrite', 'skip'
            run3DFix = false,
            optimizeTextures = false,
            maxTextureResolution = 2048,
            disableOccluders = true,
            disableCustomProps = false,
            cleanWorldProps = true,
            workers = 4,
            onProgress,
            onLog = console.log
        } = params;

        if (!inputs || inputs.length === 0) {
            throw new Error('No input map paths provided for merging.');
        }

        if (!outputDir) {
            throw new Error('No output directory specified.');
        }

        const startTime = Date.now();
        onLog(`[MERGER] Scanning input maps...`);

        // Step 1: Discover resources
        const resources = discoverResources(inputs);
        if (resources.length === 0) {
            throw new Error('No valid FiveM map resources found in specified input path(s).');
        }

        onLog(`[MERGER] Discovered ${resources.length} map resource(s): ${resources.map(r => r.name).join(', ')}`);

        // Step 2: Check collisions
        const collisions = detectCollisions(resources);
        if (collisions.length > 0) {
            onLog(`[MERGER] ⚠️ Detected ${collisions.length} file name collision(s). Applying strategy: "${conflictStrategy}"`);
        } else {
            onLog(`[MERGER] ✓ Zero file name collisions detected.`);
        }

        const { plannedFiles, resolutionLog } = resolveCollisions(resources, conflictStrategy);

        // Step 3: Prepare output directories
        const outStreamDir = path.join(outputDir, 'stream');
        fs.mkdirSync(outStreamDir, { recursive: true });

        // Step 4: Copy files
        onLog(`[MERGER] Copying ${plannedFiles.length} stream and data files to destination...`);
        let copied = 0;
        for (const item of plannedFiles) {
            const destPath = path.join(outputDir, item.targetRelPath);
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(item.sourcePath, destPath);
            copied++;

            if (onProgress) {
                onProgress({
                    phase: 'copy',
                    current: copied,
                    total: plannedFiles.length,
                    percent: Math.round((copied / plannedFiles.length) * 50)
                });
            }
        }

        // Step 5: Gather archetypes (.ytyp) and extra data_files from resources
        const ytypFiles = [];
        const extraDataFiles = new Map(); // key: type + path
        const manifestFilesList = new Set();

        // Scan the output stream directory directly for all .ytyp files
        const allCopied = walkDirectory(outStreamDir);
        for (const cp of allCopied) {
            const ext = path.extname(cp).toLowerCase();
            const rel = path.relative(outputDir, cp).replace(/\\/g, '/');
            if (ext === '.ytyp') {
                ytypFiles.push(rel);
            }
        }

        // Collect custom data_files from each source manifest
        for (const res of resources) {
            if (res.manifestInfo && res.manifestInfo.dataFiles) {
                for (const df of res.manifestInfo.dataFiles) {
                    if (df.type !== 'DLC_ITYP_REQUEST') {
                        extraDataFiles.set(`${df.type}:${df.file}`, df);
                    }
                }
            }
        }

        // Step 6: Generate unified fxmanifest.lua
        onLog(`[MERGER] Generating unified fxmanifest.lua with ${ytypFiles.length} archetype declaration(s)...`);
        const manifestContent = this.generateFxManifest({
            resourceName,
            sourceResources: resources.map(r => r.name),
            ytypFiles,
            extraDataFiles: Array.from(extraDataFiles.values()),
            filesList: Array.from(manifestFilesList)
        });

        fs.writeFileSync(path.join(outputDir, 'fxmanifest.lua'), manifestContent, 'utf8');

        // Step 7: Optional 3D Model Fix
        let fixStats = null;
        if (run3DFix) {
            onLog(`[MERGER] Starting integrated 3D vertex repair across merged models...`);
            fixStats = await this.fixer.fix({
                inputDir: outStreamDir,
                outputDir: outStreamDir,
                workers,
                onLog,
                onProgress: (p) => {
                    if (onProgress) {
                        onProgress({
                            phase: 'fix',
                            current: p.current,
                            total: p.total,
                            percent: 50 + Math.round((p.percent / 100) * 50),
                            totalFixed: p.totalFixed
                        });
                    }
                }
            });
        }

        // Step 8: Apply Prop Cleaning & Texture Rescue if requested
        if (disableOccluders || disableCustomProps) {
            onLog(`[MERGER] Optimizing map ymaps (disableOccluders=${disableOccluders}, disableCustomProps=${disableCustomProps})...`);
            this.cleaner.toggleYmaps(outputDir, { disableCustomProps, disableOccluders });
        }
        if (cleanWorldProps) {
            onLog(`[MERGER] Injecting base-game world prop remover and /texturefix rescue script...`);
            this.cleaner.injectWorldCleanerScript(outputDir);
        }

        // Step 9: Optimize Textures if requested
        let textureStats = null;
        if (optimizeTextures) {
            onLog(`[MERGER] Optimizing texture dictionaries (.ytd) for VRAM & budget limits...`);
            textureStats = await this.textureOptimizer.optimizeResource(outputDir, {
                maxResolution: maxTextureResolution,
                onLog
            });
        }

        // Step 10: Build summary reports
        const durationSeconds = Number(((Date.now() - startTime) / 1000).toFixed(2));
        const summary = {
            resourceName,
            outputDir: path.resolve(outputDir),
            mergedResources: resources.map(r => ({
                name: r.name,
                path: r.path,
                files: r.totalFiles,
                models: r.models.length,
                textures: r.textures.length,
                maps: r.maps.length
            })),
            totalFilesCopied: plannedFiles.length,
            ytypDeclarations: ytypFiles.length,
            collisionsCount: collisions.length,
            collisionStrategy: conflictStrategy,
            collisionResolutions: resolutionLog,
            fix3DApplied: run3DFix,
            fixStats,
            textureStats,
            durationSeconds
        };

        // Write summary json
        fs.writeFileSync(
            path.join(outputDir, 'merge_summary.json'),
            JSON.stringify(summary, null, 2),
            'utf8'
        );

        // Write human-readable report
        const reportText = this.generateHumanReport(summary);
        fs.writeFileSync(path.join(outputDir, 'merge_report.txt'), reportText, 'utf8');

        onLog(`[MERGER] SUCCESS: Merged ${resources.length} maps into "${resourceName}" in ${durationSeconds}s!`);
        return summary;
    }

    /**
     * Builds standard production-grade fxmanifest.lua
     */
    generateFxManifest({ resourceName, sourceResources, ytypFiles, extraDataFiles, filesList }) {
        const lines = [
            `-- ====================================================================`,
            `-- Consolidated Map Resource: ${resourceName}`,
            `-- Generated by FiveM 3D Map Toolkit & Merger`,
            `-- Source Resources: ${sourceResources.join(', ')}`,
            `-- ====================================================================`,
            ``,
            `fx_version 'cerulean'`,
            `game 'gta5'`,
            `this_is_a_map 'yes'`,
            `lua54 'yes'`,
            ``,
            `name '${resourceName}'`,
            `author 'FiveM 3D Map Toolkit'`,
            `version '1.0.0'`,
            `description 'Consolidated map pack including: ${sourceResources.join(', ')}'`,
            ``
        ];

        if (filesList && filesList.length > 0) {
            lines.push(`files {`);
            for (const f of filesList) {
                lines.push(`    '${f}',`);
            }
            lines.push(`}`);
            lines.push(``);
        }

        if (ytypFiles.length > 0) {
            lines.push(`-- Archetype definition files (.ytyp)`);
            for (const ytyp of ytypFiles) {
                lines.push(`data_file 'DLC_ITYP_REQUEST' '${ytyp}'`);
            }
            lines.push(``);
        }

        if (extraDataFiles && extraDataFiles.length > 0) {
            lines.push(`-- Additional audio/timecycle/metadata declarations`);
            for (const df of extraDataFiles) {
                lines.push(`data_file '${df.type}' '${df.file}'`);
            }
            lines.push(``);
        }

        return lines.join('\n');
    }

    /**
     * Generates a clean text report.
     */
    generateHumanReport(summary) {
        const lines = [
            `====================================================================`,
            `               FIVEM 3D MAP MERGER REPORT                           `,
            `====================================================================`,
            `Generated: ${new Date().toISOString()}`,
            `Target Resource: ${summary.resourceName}`,
            `Output Location: ${summary.outputDir}`,
            `Total Time: ${summary.durationSeconds}s`,
            ``,
            `MERGED RESOURCES (${summary.mergedResources.length}):`,
            ...summary.mergedResources.map(r => `  - ${r.name.padEnd(30)} [${r.files} files: ${r.models} models, ${r.textures} textures, ${r.maps} maps]`),
            ``,
            `ASSET TOTALS:`,
            `  - Total Files: ${summary.totalFilesCopied}`,
            `  - Registered .ytyp Archetypes: ${summary.ytypDeclarations}`,
            `  - Collisions Detected: ${summary.collisionsCount} (Strategy: ${summary.collisionStrategy})`,
            ``
        ];

        if (summary.collisionResolutions.length > 0) {
            lines.push(`COLLISION RESOLUTIONS:`);
            for (const cr of summary.collisionResolutions) {
                lines.push(`  - ${cr.file}: ${cr.resolution}`);
            }
            lines.push(``);
        }

        if (summary.fix3DApplied && summary.fixStats) {
            lines.push(`3D VERTEX REPAIR STATS:`);
            lines.push(`  - Total Models Scanned: ${summary.fixStats.totalModels}`);
            lines.push(`  - Geometries Repaired:  ${summary.fixStats.totalFixedGeometries}`);
            lines.push(`  - Files Modified:       ${summary.fixStats.fixedFiles}`);
            lines.push(`  - Clean Models:         ${summary.fixStats.cleanFiles}`);
            lines.push(`  - Errors/Reverted:      ${summary.fixStats.errorFiles}`);
            lines.push(`  - Repair Time:          ${summary.fixStats.durationSeconds}s`);
            lines.push(``);
        }

        lines.push(`INSTALLATION:`);
        lines.push(`  1. Move the folder "${summary.resourceName}" to your server's resources/ directory.`);
        lines.push(`  2. Add "ensure ${summary.resourceName}" to your server.cfg.`);
        lines.push(`====================================================================`);

        return lines.join('\n');
    }
}

module.exports = MapMerger;
