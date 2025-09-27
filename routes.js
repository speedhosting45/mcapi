const express = require('express');
const deployEngine = require('./deployEngine');

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
router.post('/deploy', async (req, res) => {
    try {
        const { edition, version, motd, ram, serverName } = req.body;

        // Validate required fields
        if (!edition || !version) {
            return res.status(400).json({ 
                error: 'Edition and version are required' 
            });
        }

        // Generate server ID
        const serverId = `mc-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

        const deployConfig = {
            serverId,
            edition: edition.toLowerCase(),
            version: version,
            motd: motd || 'A Minecraft Server',
            ram: Math.min(parseInt(ram) || 2, parseInt(process.env.MINECRAFT_MAX_RAM) || 8),
            serverName: serverName || serverId
        };

        const result = await deployEngine.deployServer(deployConfig);
        
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json(result);
        }

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

// Get available versions
// Get available versions
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

module.exports = router;
