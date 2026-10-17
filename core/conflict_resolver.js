const path = require('path');

/**
 * Detects filename collisions across multiple resources.
 * Returns a map of filename -> array of file records.
 */
function detectCollisions(resources) {
    const filenameMap = new Map();
    const collisions = [];

    for (const res of resources) {
        for (const file of res.allFiles) {
            // Manifests are handled specially by merging, so ignore them in general collision list
            if (file.category === 'manifest') continue;

            const baseName = file.name.toLowerCase();
            if (!filenameMap.has(baseName)) {
                filenameMap.set(baseName, []);
            }
            filenameMap.get(baseName).push({
                resourceName: res.name,
                file
            });
        }
    }

    for (const [name, occurrences] of filenameMap.entries()) {
        if (occurrences.length > 1) {
            collisions.push({
                filename: name,
                category: occurrences[0].file.category,
                occurrences: occurrences.map(o => ({
                    resource: o.resourceName,
                    path: o.file.fullPath,
                    size: o.file.size,
                    mtime: o.file.mtime
                }))
            });
        }
    }

    return collisions;
}

/**
 * Plans file mappings and resolves any collisions using the selected strategy.
 * Strategies: 'keep_newest', 'keep_largest', 'prefix', 'overwrite', 'skip'
 */
function resolveCollisions(resources, strategy = 'keep_newest') {
    const resolvedOutputs = new Map(); // targetRelPath -> sourceFileRecord
    const resolutionLog = [];

    for (const res of resources) {
        for (const file of res.allFiles) {
            if (file.category === 'manifest') continue;

            // Target relative path: usually stream/filename.ext or data/filename.ext
            let targetRelPath = '';
            if (file.isStreamAsset || file.category === 'model' || file.category === 'texture' ||
                file.category === 'map' || file.category === 'collision' || file.category === 'archetype') {
                targetRelPath = `stream/${file.name}`;
            } else {
                targetRelPath = file.relPath;
            }

            const lowerKey = targetRelPath.toLowerCase();

            if (!resolvedOutputs.has(lowerKey)) {
                resolvedOutputs.set(lowerKey, {
                    sourcePath: file.fullPath,
                    targetRelPath,
                    resourceName: res.name,
                    file
                });
            } else {
                const existing = resolvedOutputs.get(lowerKey);
                let winner = existing;
                let action = 'retained';

                if (strategy === 'prefix') {
                    // Rename new file with prefix
                    const ext = file.ext;
                    const baseNoExt = path.basename(file.name, ext);
                    const prefixedName = `${res.name}_${baseNoExt}${ext}`;
                    const prefixedTarget = `stream/${prefixedName}`;
                    const prefixedKey = prefixedTarget.toLowerCase();

                    resolvedOutputs.set(prefixedKey, {
                        sourcePath: file.fullPath,
                        targetRelPath: prefixedTarget,
                        resourceName: res.name,
                        file
                    });

                    resolutionLog.push({
                        file: file.name,
                        collisionBetween: [existing.resourceName, res.name],
                        strategy: 'prefix',
                        resolution: `Renamed ${file.name} to ${prefixedName} for resource ${res.name}`
                    });
                    continue;
                } else if (strategy === 'keep_newest') {
                    const existingTime = existing.file.mtime ? new Date(existing.file.mtime).getTime() : 0;
                    const newTime = file.mtime ? new Date(file.mtime).getTime() : 0;
                    if (newTime > existingTime) {
                        winner = {
                            sourcePath: file.fullPath,
                            targetRelPath,
                            resourceName: res.name,
                            file
                        };
                        resolvedOutputs.set(lowerKey, winner);
                        action = `replaced by newer version from ${res.name}`;
                    } else {
                        action = `kept older version from ${existing.resourceName}`;
                    }
                } else if (strategy === 'keep_largest') {
                    if (file.size > existing.file.size) {
                        winner = {
                            sourcePath: file.fullPath,
                            targetRelPath,
                            resourceName: res.name,
                            file
                        };
                        resolvedOutputs.set(lowerKey, winner);
                        action = `replaced by larger version (${file.size} bytes) from ${res.name}`;
                    } else {
                        action = `kept larger version (${existing.file.size} bytes) from ${existing.resourceName}`;
                    }
                } else if (strategy === 'overwrite') {
                    winner = {
                        sourcePath: file.fullPath,
                        targetRelPath,
                        resourceName: res.name,
                        file
                    };
                    resolvedOutputs.set(lowerKey, winner);
                    action = `overwritten by ${res.name}`;
                } else if (strategy === 'skip') {
                    action = `skipped version from ${res.name}`;
                }

                resolutionLog.push({
                    file: file.name,
                    collisionBetween: [existing.resourceName, res.name],
                    strategy,
                    resolution: action
                });
            }
        }
    }

    return {
        plannedFiles: Array.from(resolvedOutputs.values()),
        resolutionLog
    };
}

module.exports = {
    detectCollisions,
    resolveCollisions
};
