const express = require('express');
const deployEngine = require('./deployEngine');
const fs = require('fs').promises;
const path = require('path');

const router = express.Router();

// API Key Authentication Middleware
const authenticate = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
        return res.status(401).json({ error: 'API key required' });
    }
    
    if (apiKey !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    next();
};

// Apply authentication to all routes except health check
router.use((req, res, next) => {
    if (req.path === '/health') {
        return next();
    }
    authenticate(req, res, next);
});

// Health check (no auth required)
router.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Minecraft Deploy API is running',
        timestamp: new Date().toISOString()
    });
});

// Deploy a new server
// Deploy a new server
router.post('/deploy', async (req, res) => {
    try {
        const { 
            edition, 
            version, 
            motd, 
            ram, 
            serverName,
            // Advanced options
            gamemode,
            difficulty,
            maxPlayers,
            viewDistance,
            simulationDistance,
            pvp,
            spawnProtection,
            spawnAnimals,
            spawnMonsters,
            spawnNpcs,
            allowNether,
            allowEnd,
            allowFlight,
            whiteList,
            enforceWhitelist,
            enableCommandBlock,
            onlineMode,
            loadingScreen
        } = req.body;

        if (!edition || !version) {
            return res.status(400).json({ 
                error: 'Edition and version are required' 
            });
        }

        const serverId = `mc-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

        // IMMEDIATE RESPONSE WITH SERVER ID
        res.json({ 
            success: true, 
            serverId, 
            status: 'deploying',
            message: 'Server deployment started successfully',
            progressUrl: `/api/servers/${serverId}/progress`,
            logsUrl: `/api/servers/${serverId}/logs/live`,
            commandUrl: `/api/servers/${serverId}/command`
        });

        // Continue deployment in background (non-blocking)
        const deployConfig = {
            serverId,
            edition: edition.toLowerCase(),
            version: version,
            motd: motd || 'A Minecraft Server',
            ram: Math.min(parseInt(ram) || 2, parseInt(process.env.MINECRAFT_MAX_RAM) || 8),
            serverName: serverName || serverId,
            // Advanced options with defaults
            gamemode: gamemode || 'survival',
            difficulty: difficulty || 'easy',
            maxPlayers: parseInt(maxPlayers) || 20,
            viewDistance: parseInt(viewDistance) || 10,
            simulationDistance: parseInt(simulationDistance) || 10,
            pvp: pvp !== false,
            spawnProtection: parseInt(spawnProtection) || 16,
            spawnAnimals: spawnAnimals !== false,
            spawnMonsters: spawnMonsters !== false,
            spawnNpcs: spawnNpcs !== false,
            allowNether: allowNether !== false,
            allowEnd: allowEnd !== false,
            allowFlight: allowFlight || false,
            whiteList: whiteList || false,
            enforceWhitelist: enforceWhitelist || false,
            enableCommandBlock: enableCommandBlock || false,
            onlineMode: onlineMode !== false,
            loadingScreen: loadingScreen || { enabled: true, type: 'default' }
        };

        // Start deployment in background
        deployEngine.deployServer(deployConfig).catch(error => {
            console.error(`Background deployment failed for ${serverId}:`, error);
        });

    } catch (error) {
        console.error('Deployment error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Get server status
router.get('/servers/:serverId/status', async (req, res) => {
    try {
        const { serverId } = req.params;
        const status = deployEngine.getServerStatus(serverId);
        
        res.json({ 
            serverId, 
            status,
            message: `Server status: ${status}`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Stop a server
router.post('/servers/:serverId/stop', async (req, res) => {
    try {
        const { serverId } = req.params;
        const success = await deployEngine.stopServer(serverId);
        
        res.json({ 
            success, 
            serverId,
            message: success ? 'Server stopped successfully' : 'Failed to stop server'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete a server
router.delete('/servers/:serverId', async (req, res) => {
    try {
        const { serverId } = req.params;
        const success = await deployEngine.deleteServer(serverId);
        
        res.json({ 
            success, 
            serverId,
            message: success ? 'Server deleted successfully' : 'Failed to delete server'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all active servers
router.get('/servers', async (req, res) => {
    try {
        const servers = deployEngine.getAllServers();
        res.json({ 
            count: servers.length,
            servers 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get available versions for an edition
router.get('/versions/:edition', async (req, res) => {
    try {
        const { edition } = req.params;
        
        const versions = {
            paper: ['1.21.1', '1.21', '1.20.4', '1.20.1', '1.19.4'],
            vanilla: ['1.21.1', '1.21', '1.20.4', '1.20.1', '1.19.4'],
            fabric: ['1.21.1', '1.21', '1.20.4', '1.20.1', '1.19.4'],
            forge: ['1.21.1', '1.21', '1.20.4', '1.20.1', '1.19.4']
        };

        if (!versions[edition]) {
            return res.status(400).json({ error: 'Unsupported edition' });
        }

        res.json({ 
            edition, 
            versions: versions[edition] 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// RESTART SERVER
router.post('/servers/:serverId/restart', async (req, res) => {
    try {
        const { serverId } = req.params;
        
        const success = await deployEngine.restartServer(serverId);
        
        res.json({ 
            success: true, 
            serverId,
            message: 'Server restarted successfully' 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            message: 'Failed to restart server' 
        });
    }
});

// ADD MOD TO SERVER
router.post('/servers/:serverId/mods', async (req, res) => {
    try {
        const { serverId } = req.params;
        const { modUrl, modName } = req.body;
        
        if (!modUrl) {
            return res.status(400).json({ 
                success: false, 
                error: 'modUrl is required' 
            });
        }
        
        const result = await deployEngine.addMod(serverId, modUrl, modName);
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            message: 'Failed to add mod' 
        });
    }
});

// LIST SERVER MODS
router.get('/servers/:serverId/mods', async (req, res) => {
    try {
        const { serverId } = req.params;
        
        const mods = await deployEngine.listMods(serverId);
        
        res.json({ 
            success: true, 
            serverId,
            mods,
            count: mods.length 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            message: 'Failed to list mods' 
        });
    }
});

// DELETE MOD FROM SERVER
router.delete('/servers/:serverId/mods/:modName', async (req, res) => {
    try {
        const { serverId, modName } = req.params;
        
        const result = await deployEngine.deleteMod(serverId, modName);
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            message: 'Failed to delete mod' 
        });
    }
});

// PLAYER MANAGEMENT ROUTES
router.post('/servers/:serverId/players', async (req, res) => {
    try {
        const { serverId } = req.params;
        const { playerName, playerUuid, opLevel } = req.body;
        
        if (!playerName) {
            return res.status(400).json({ error: 'playerName is required' });
        }

        const result = await deployEngine.addPlayer(serverId, playerName, playerUuid, opLevel || 0);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/servers/:serverId/players/:playerName', async (req, res) => {
    try {
        const { serverId, playerName } = req.params;
        const result = await deployEngine.removePlayer(serverId, playerName);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/servers/:serverId/players', async (req, res) => {
    try {
        const { serverId } = req.params;
        const players = await deployEngine.listPlayers(serverId);
        res.json({ success: true, players, count: players.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// SERVER SETTINGS MANAGEMENT
router.patch('/servers/:serverId/settings', async (req, res) => {
    try {
        const { serverId } = req.params;
        const settings = req.body;
        
        if (!settings || Object.keys(settings).length === 0) {
            return res.status(400).json({ error: 'Settings object is required' });
        }

        const result = await deployEngine.updateServerSettings(serverId, settings);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// NEW FEATURES:

// LIVE LOG STREAMING
router.get('/servers/:serverId/logs/live', async (req, res) => {
    try {
        const { serverId } = req.params;
        
        // Check if server exists
        const serverDir = path.join(process.env.MINECRAFT_BASE_DIR || '/home/servers', serverId);
        try {
            await fs.access(serverDir);
        } catch (error) {
            return res.status(404).json({ error: 'Server not found' });
        }

        // Setup live log streaming
        deployEngine.setupLiveLogs(serverId, res);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// TERMINAL COMMAND EXECUTION
router.post('/servers/:serverId/command', async (req, res) => {
    try {
        const { serverId } = req.params;
        const { command } = req.body;
        
        if (!command) {
            return res.status(400).json({ error: 'Command is required' });
        }

        const result = await deployEngine.executeCommand(serverId, command);
        res.json(result);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            message: 'Failed to execute command' 
        });
    }
});

// DEPLOYMENT PROGRESS
router.get('/servers/:serverId/progress', async (req, res) => {
    try {
        const { serverId } = req.params;
        const progress = deployEngine.getProgress(serverId);
        res.json(progress);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
