const fs = require('fs');
const path = require('path');

class PropCleaner {
    constructor() {}

    /**
     * Scans a map resource stream directory for prop and occluder ymaps.
     * @param {string} resourceDir 
     */
    scanResource(resourceDir) {
        const streamDir = path.join(resourceDir, 'stream');
        const targetDir = fs.existsSync(streamDir) ? streamDir : resourceDir;

        const propYmaps = [];
        const occlYmaps = [];
        const disabledFiles = [];

        if (!fs.existsSync(targetDir)) {
            return { propYmaps, occlYmaps, disabledFiles };
        }

        const files = fs.readdirSync(targetDir);
        for (const file of files) {
            const lower = file.toLowerCase();
            const fullPath = path.join(targetDir, file);

            if (lower.endsWith('.disabled')) {
                disabledFiles.push({ file, path: fullPath });
            } else if (lower.endsWith('.ymap')) {
                if (lower.includes('prop') || lower.includes('trash') || lower.includes('debris') || lower.includes('light') || lower.includes('tuner')) {
                    propYmaps.push({ file, path: fullPath, size: fs.statSync(fullPath).size });
                } else if (lower.includes('occl') || lower.includes('occlusion')) {
                    occlYmaps.push({ file, path: fullPath, size: fs.statSync(fullPath).size });
                }
            }
        }

        return { propYmaps, occlYmaps, disabledFiles };
    }

    /**
     * Disables or restores prop and occluder ymaps.
     * @param {string} resourceDir 
     * @param {Object} options
     * @param {boolean} options.disableCustomProps - Disable *props*.ymap files
     * @param {boolean} options.disableOccluders - Disable *occl*.ymap files (stops texture/geometry disappearing)
     */
    toggleYmaps(resourceDir, options = {}) {
        const { disableCustomProps = true, disableOccluders = true } = options;
        const streamDir = path.join(resourceDir, 'stream');
        const targetDir = fs.existsSync(streamDir) ? streamDir : resourceDir;

        if (!fs.existsSync(targetDir)) return { modified: [] };

        const modified = [];
        const files = fs.readdirSync(targetDir);

        for (const file of files) {
            const lower = file.toLowerCase();
            const fullPath = path.join(targetDir, file);

            // Handle Occluders
            if (lower.includes('occl') || lower.includes('occlusion')) {
                if (disableOccluders && lower.endsWith('.ymap')) {
                    const newPath = fullPath + '.disabled';
                    fs.renameSync(fullPath, newPath);
                    modified.push({ action: 'disabled_occluder', file, newPath });
                } else if (!disableOccluders && lower.endsWith('.disabled')) {
                    const newPath = fullPath.replace(/\.disabled$/i, '');
                    fs.renameSync(fullPath, newPath);
                    modified.push({ action: 'restored_occluder', file, newPath });
                }
            }

            // Handle Custom Props & Conflicting DLC Ymaps
            if (lower.includes('prop') || lower.includes('trash') || lower.includes('debris') || lower.includes('tuner_shop_rancho')) {
                if (disableCustomProps && lower.endsWith('.ymap')) {
                    const newPath = fullPath + '.disabled';
                    fs.renameSync(fullPath, newPath);
                    modified.push({ action: 'disabled_prop_ymap', file, newPath });
                } else if (!disableCustomProps && lower.endsWith('.disabled')) {
                    const newPath = fullPath.replace(/\.disabled$/i, '');
                    fs.renameSync(fullPath, newPath);
                    modified.push({ action: 'restored_prop_ymap', file, newPath });
                }
            }
        }

        return { modified };
    }

    /**
     * Injects client-side world prop remover & texture fix scripts into the resource.
     * @param {string} resourceDir 
     * @param {Object} [config]
     */
    injectWorldCleanerScript(resourceDir, config = {}) {
        const clientDir = path.join(resourceDir, 'client');
        if (!fs.existsSync(clientDir)) {
            fs.mkdirSync(clientDir, { recursive: true });
        }

        const scriptContent = `--[[
    FiveM World Prop Remover & Texture Rescue System
    Automatically hides default GTA V world props (telephone poles, dumpsters, fences, billboards)
    and unloads conflicting DLC buildings (like Rancho Auto Shop) to prevent clipping.
    Also provides /texturefix to eliminate flickering or disappearing textures.
]]

local CenterZone = vector3(${config.x || 400.0}, ${config.y || -1880.0}, ${config.z || 25.0})
local CleanRadius = ${config.radius || 550.0}

-- 1. Unload Conflicting DLC IPLs (Removes Rancho Auto Shop)
CreateThread(function()
    RemoveIpl("tr_tuner_shop_rancho")
    RemoveIpl("tr_tuner_shop_rancho_lod")
    RemoveIpl("tr_tuner_meetup")
end)

-- 2. Default GTA V world clutter prop and building hashes to delete/hide
local WorldPropHashes = {
    -- Conflicting Sector Buildings (Rancho Auto Shop & SC1_28 structures)
    GetHashKey("tr_sc1_28_tuner"),
    GetHashKey("tr_sc1_28_tuner_lod"),
    GetHashKey("sc1_28_build01"),
    GetHashKey("sc1_28_build01b"),
    GetHashKey("sc1_28_build02"),
    GetHashKey("sc1_28_build03"),
    GetHashKey("sc1_28_res01"),
    GetHashKey("sc1_28_res02"),
    GetHashKey("sc1_28_shops01"),

    -- Utility & Power Poles
    GetHashKey("prop_utility_pole_01"),
    GetHashKey("prop_utility_pole_02"),
    GetHashKey("prop_utility_pole_03"),
    GetHashKey("prop_telegraph_01a"),
    GetHashKey("prop_telegraph_01b"),
    GetHashKey("prop_telegraph_02a"),
    GetHashKey("prop_power_pole_01a"),
    GetHashKey("prop_power_pole_02a"),
    GetHashKey("prop_power_pole_03a"),
    GetHashKey("prop_cable_reel_01"),

    -- Billboards & Roof Signs
    GetHashKey("prop_billboard_01"),
    GetHashKey("prop_billboard_02"),
    GetHashKey("prop_billboard_03"),
    GetHashKey("prop_billboard_04"),
    GetHashKey("prop_billboard_05"),
    GetHashKey("prop_billboard_06"),
    GetHashKey("prop_billboard_07"),
    GetHashKey("prop_billboard_08"),
    GetHashKey("prop_billboard_09"),
    GetHashKey("prop_billboard_10"),
    GetHashKey("prop_billboard_11"),
    GetHashKey("prop_billboard_12"),
    GetHashKey("prop_billboard_13"),
    GetHashKey("prop_billboard_14"),
    GetHashKey("prop_billboard_15"),

    -- Dumpsters & Trash Cans
    GetHashKey("prop_dumpster_01a"),
    GetHashKey("prop_dumpster_02a"),
    GetHashKey("prop_dumpster_02b"),
    GetHashKey("prop_dumpster_4a"),
    GetHashKey("prop_dumpster_4b"),
    GetHashKey("prop_cs_dumpster_01a"),
    GetHashKey("prop_bin_01a"),
    GetHashKey("prop_bin_07a"),
    GetHashKey("prop_trash_bin_01"),
    GetHashKey("prop_wheelb_01a"),

    -- Fences & Enclosures
    GetHashKey("prop_fnclink_02f"),
    GetHashKey("prop_fnclink_03a"),
    GetHashKey("prop_fnclink_03e"),
    GetHashKey("prop_fnclink_04a"),
    GetHashKey("prop_fnclink_05a"),
    GetHashKey("prop_fnclink_07a"),
    GetHashKey("prop_fncwood_02a"),
    GetHashKey("prop_fncsec_04a"),
    GetHashKey("prop_fence_log_01"),
    GetHashKey("prop_sheet_metal_01"),
    GetHashKey("prop_ind_fence_01"),

    -- Clutter & Miscellaneous
    GetHashKey("prop_rub_boxpile_01"),
    GetHashKey("prop_rub_litter_01"),
    GetHashKey("prop_rub_tyre_01"),
    GetHashKey("prop_rub_tyre_02"),
    GetHashKey("prop_couch_01"),
    GetHashKey("prop_satellite_01"),
    GetHashKey("prop_aircon_l_01"),
    GetHashKey("prop_aircon_m_01"),

    -- Trees & Vegetation clipping into lots
    GetHashKey("prop_tree_palm_01"),
    GetHashKey("prop_tree_palm_02"),
    GetHashKey("prop_tree_cedar_01"),
    GetHashKey("prop_tree_dead_01"),
    GetHashKey("prop_tree_birch_01")
}

local hashSet = {}
for _, h in ipairs(WorldPropHashes) do
    hashSet[h] = true
end

-- 3. Native Engine-level Model Hiding
CreateThread(function()
    for _, modelHash in ipairs(WorldPropHashes) do
        CreateModelHide(CenterZone.x, CenterZone.y, CenterZone.z, CleanRadius, modelHash, true)
        CreateModelHideExcludingScriptObjects(CenterZone.x, CenterZone.y, CenterZone.z, CleanRadius, modelHash, true)
    end
end)

-- 4. Active World Entity Purge Loop
local function PurgeNearbyWorldProps()
    local ped = PlayerPedId()
    local pCoords = GetEntityCoords(ped)
    local distToMap = #(pCoords - CenterZone)

    if distToMap <= CleanRadius + 150.0 then
        local handle, object = FindFirstObject()
        local success = true

        while success do
            if DoesEntityExist(object) then
                local model = GetEntityModel(object)
                if hashSet[model] then
                    local objCoords = GetEntityCoords(object)
                    if #(objCoords - CenterZone) <= CleanRadius then
                        SetEntityAsMissionEntity(object, true, true)
                        DeleteObject(object)
                        SetEntityCoords(object, 0.0, 0.0, -1000.0, false, false, false, false)
                    end
                end
            end
            success, object = FindNextObject(handle)
        end
        EndFindObject(handle)
    end
end

CreateThread(function()
    while true do
        Wait(1500)
        PurgeNearbyWorldProps()
    end
end)

-- In-game manual cleaner command
RegisterCommand("propclean", function()
    PurgeNearbyWorldProps()
    TriggerEvent("chat:addMessage", {
        color = { 76, 175, 80 },
        multiline = true,
        args = { "[MapToolkit]", "Surrounding world clutter props purged successfully." }
    })
end, false)

-- Texture & Collision Rescue (/texturefix)
RegisterCommand("texturefix", function()
    local ped = PlayerPedId()
    if IsEntityDead(ped) then return end

    local coords = GetEntityCoords(ped)
    local heading = GetEntityHeading(ped)

    DoScreenFadeOut(500)
    while not IsScreenFadedOut() do Wait(10) end

    FreezeEntityPosition(ped, true)
    SetEntityCoordsNoOffset(ped, coords.x, coords.y, coords.z + 1.0, false, false, false)
    SetEntityHeading(ped, heading)

    RequestCollisionAtCoord(coords.x, coords.y, coords.z)
    local start = GetGameTimer()
    while not HasCollisionLoadedAroundEntity(ped) and (GetGameTimer() - start) < 4000 do
        Wait(50)
    end

    FreezeEntityPosition(ped, false)
    DoScreenFadeIn(500)

    TriggerEvent("chat:addMessage", {
        color = { 0, 229, 255 },
        multiline = true,
        args = { "[MapToolkit]", "Textures and world collisions refreshed!" }
    })
end, false)

TriggerEvent('chat:addSuggestion', '/texturefix', 'Refreshes and reloads flickering or missing world textures.')
TriggerEvent('chat:addSuggestion', '/propclean', 'Forcefully purges lingering base-game clutter props.')
`;

        const scriptPath = path.join(clientDir, 'world_cleaner.lua');
        fs.writeFileSync(scriptPath, scriptContent, 'utf8');

        // Update fxmanifest.lua
        const manifestPath = path.join(resourceDir, 'fxmanifest.lua');
        if (fs.existsSync(manifestPath)) {
            let manifest = fs.readFileSync(manifestPath, 'utf8');
            if (!manifest.includes('client/world_cleaner.lua')) {
                manifest += `\nclient_script 'client/world_cleaner.lua'\n`;
                fs.writeFileSync(manifestPath, manifest, 'utf8');
            }
        }

        return { scriptPath, manifestUpdated: true };
    }
}

module.exports = PropCleaner;
