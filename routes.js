const express = require('express');
const deployEngine = require('./deployEngine');

const router = express.Router();

//
// 🛡 API KEY AUTH MIDDLEWARE
//
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

// Apply authentication to all routes except /health
router.use((req, res, next) => {
    if (req.path === '/health') return next();
    authenticate(req, res, next);
});

//
// 🩺 HEALTH CHECK (No Auth)
//
router.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Minecraft Deploy API is running',
        timestamp: new Date().toISOString()
    });
});

// START SERVER
// START SERVER (Improved)
router.post('/servers/:serverId/start', async (req, res) => {
    try {
        const { serverId } = req.params;
        let serverConfig = deployEngine.activeServers.get(serverId);

        // 📝 If not found in memory, try loading from server.config.json
        if (!serverConfig) {
            const serverDir = path.join(process.env.MINECRAFT_BASE_DIR || '/home/servers', serverId);
            const configPath = path.join(serverDir, 'server.config.json');

            try {
                const rawConfig = await fs.readFile(configPath, 'utf8');
                serverConfig = JSON.parse(rawConfig);
            } catch (e) {
                return res.status(404).json({ success: false, error: 'Server not found or not deployed yet' });
            }
        }

        await deployEngine.startServer(
            serverConfig.directory || path.join(process.env.MINECRAFT_BASE_DIR || '/home/servers', serverId),
            serverId,
            serverConfig.ram,
            serverConfig.port
        );

        serverConfig.status = 'running';
        serverConfig.restartedAt = new Date();
        deployEngine.activeServers.set(serverId, serverConfig);

        res.json({ success: true, message: `✅ Server ${serverId} started successfully` });

    } catch (error) {
        console.error(`❌ Failed to start server ${req.params.serverId}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});


//
// 🚀 DEPLOY SERVER (ADVANCED)
//
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
            return res.status(400).json({ error: 'Edition and version required' });
        }

        const serverId = `mc-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

        const deployConfig = {
            serverId,
            edition: edition.toLowerCase(),
            version,
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

        const result = await deployEngine.deployServer(deployConfig);

        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json(result);
        }

    } catch (error) {
        console.error('Deployment error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

//
// 📡 SERVER STATUS
//
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

//
// 🛑 STOP SERVER
//
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

//
// 🗑 DELETE SERVER
//
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

//
// 🌐 LIST ACTIVE SERVERS
//
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

//
// 🧭 GET AVAILABLE VERSIONS
//
router.get('/versions/:edition', async (req, res) => {
    try {
        const { edition } = req.params;

        const versions = {
            paper: ['1.21.1', '1.21', '1.20.1'],
            vanilla: ['1.21.1', '1.21', '1.20.1'],
            fabric: ['1.21.1', '1.21', '1.20.1'],
            forge: ['1.21.1', '1.21', '1.20.1']
        };

        if (!versions[edition]) {
            return res.status(400).json({ error: 'Unsupported edition' });
        }

        res.json({ edition, versions: versions[edition] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

//
// 🧍 PLAYER MANAGEMENT
//
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

//
// ⚙️ SERVER SETTINGS MANAGEMENT
//
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

module.exports = router;
