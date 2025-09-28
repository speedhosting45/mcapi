const express = require('express');
const deployEngine = require('./deployEngine');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

const router = express.Router();

//
// 🛡 API KEY AUTH MIDDLEWARE
//
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API key required' });
  if (apiKey !== process.env.API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
};

router.use((req, res, next) => {
  if (req.path === '/health') return next();
  authenticate(req, res, next);
});

//
// 🩺 HEALTH CHECK
//
router.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Minecraft Deploy API is running',
    timestamp: new Date().toISOString(),
  });
});

//
// 🚀 DEPLOY SERVER (ADVANCED)
//
router.post('/deploy', async (req, res) => {
  try {
    const { edition, version } = req.body;
    if (!edition || !version) {
      return res.status(400).json({ error: 'Edition and version required' });
    }

    const serverId = `mc-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const deployConfig = {
      ...req.body,
      serverId,
      edition: edition.toLowerCase(),
      ram: Math.min(parseInt(req.body.ram) || 2, parseInt(process.env.MINECRAFT_MAX_RAM) || 8),
    };

    // Start async deployment
    deployEngine.deployServer(deployConfig);

    res.json({
      success: true,
      serverId,
      message: 'Deployment started. Use /progress or /logs/live to track progress.',
    });
  } catch (error) {
    console.error('Deployment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

//
// 📊 DEPLOYMENT PROGRESS ENDPOINT
//
router.get('/servers/:serverId/progress', (req, res) => {
  const { serverId } = req.params;
  const progress = deployEngine.getDeploymentProgress(serverId);
  if (!progress) return res.status(404).json({ error: 'No deployment in progress' });
  res.json(progress);
});

//
// 📝 START SERVER
//
router.post('/servers/:serverId/start', async (req, res) => {
  try {
    const { serverId } = req.params;
    let serverConfig = deployEngine.activeServers.get(serverId);

    if (!serverConfig) {
      const serverDir = path.join(process.env.MINECRAFT_BASE_DIR || '/home/servers', serverId);
      const configPath = path.join(serverDir, 'server.config.json');

      try {
        const rawConfig = await fsp.readFile(configPath, 'utf8');
        serverConfig = JSON.parse(rawConfig);
      } catch {
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
// 🛑 STOP SERVER
//
router.post('/servers/:serverId/stop', async (req, res) => {
  try {
    const { serverId } = req.params;
    const success = await deployEngine.stopServer(serverId);
    res.json({
      success,
      serverId,
      message: success ? 'Server stopped successfully' : 'Failed to stop server',
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
      message: success ? 'Server deleted successfully' : 'Failed to delete server',
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
      servers,
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
      forge: ['1.21.1', '1.21', '1.20.1'],
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
// ⚙️ SERVER SETTINGS
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

//
// 🛰 LIVE LOG STREAMING (SSE) + DEPLOY PROGRESS
//
router.get('/servers/:serverId/logs/live', (req, res) => {
  const { serverId } = req.params;
  const serverDir = path.join(process.env.MINECRAFT_BASE_DIR || '/home/servers', serverId);
  const logFile = path.join(serverDir, 'server.log');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // 🔸 Send deployment progress periodically
  const progressInterval = setInterval(() => {
    const progress = deployEngine.getDeploymentProgress(serverId);
    if (progress) {
      res.write(`event: progress\n`);
      res.write(`data: ${JSON.stringify(progress)}\n\n`);
    }
  }, 1000);

  // 🔸 Tail log file
  if (fs.existsSync(logFile)) {
    let fileSize = fs.statSync(logFile).size;

    const watcher = fs.watch(logFile, (event) => {
      if (event === 'change') {
        const newSize = fs.statSync(logFile).size;
        if (newSize > fileSize) {
          const stream = fs.createReadStream(logFile, { start: fileSize, end: newSize });
          stream.on('data', chunk => {
            res.write(`event: log\n`);
            res.write(`data: ${chunk.toString()}\n\n`);
          });
          fileSize = newSize;
        }
      }
    });

    req.on('close', () => {
      watcher.close();
      clearInterval(progressInterval);
      res.end();
    });
  } else {
    req.on('close', () => {
      clearInterval(progressInterval);
      res.end();
    });
  }
});

//
// ⌨️ TERMINAL COMMAND EXECUTION
//
router.post('/servers/:serverId/command', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'Command is required' });

    const success = await deployEngine.sendCommandToServer(serverId, command);
    if (success) res.json({ success: true, message: 'Command sent' });
    else res.status(500).json({ success: false, message: 'Failed to send command' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
