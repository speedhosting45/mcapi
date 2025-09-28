const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const util = require('util');

const execAsync = util.promisify(exec);

class DeployEngine {
    constructor() {
        this.portStart = parseInt(process.env.MINECRAFT_PORT_START) || 25565;
        this.portEnd = parseInt(process.env.MINECRAFT_PORT_END) || 26000;
        this.baseDir = process.env.MINECRAFT_BASE_DIR || '/home/servers';
        this.activeServers = new Map();
        this.serverConfigs = new Map();
        this.deployProgress = new Map(); // Track deployment progress
        this.logStreams = new Map(); // Track active log streams
    }

    // MAIN DEPLOYMENT METHOD
    async deployServer(deployConfig) {
        const { 
            serverId, 
            edition, 
            version, 
            motd, 
            ram, 
            serverName,
            // Advanced options
            gamemode = 'survival',
            difficulty = 'easy',
            maxPlayers = 20,
            viewDistance = 10,
            simulationDistance = 10,
            pvp = true,
            spawnProtection = 16,
            spawnAnimals = true,
            spawnMonsters = true,
            spawnNpcs = true,
            allowNether = true,
            allowEnd = true,
            allowFlight = false,
            whiteList = false,
            enforceWhitelist = false,
            enableCommandBlock = false,
            onlineMode = true,
            // Loading screen configuration
            loadingScreen = {
                enabled: true,
                type: 'default',
                message: 'Server is starting...',
                percentage: null
            }
        } = deployConfig;

        try {
            console.log(`🚀 Starting deployment: ${serverId} (${edition} ${version})`);
            this.updateProgress(serverId, 0, 'Starting deployment...');
            
            // Show loading screen simulation
            if (loadingScreen.enabled) {
                await this.showLoadingScreen(loadingScreen, serverId);
            }

            // Validate inputs
            await this.validateConfig(deployConfig);
            this.updateProgress(serverId, 10, 'Configuration validated');

            // Check Java installation
            await this.checkJavaInstallation();
            this.updateProgress(serverId, 15, 'Java verified');

            // Create server directory
            const serverDir = path.join(this.baseDir, serverId);
            await fs.mkdir(serverDir, { recursive: true });

            // Allocate port
            const port = await this.findAvailablePort();
            this.updateProgress(serverId, 20, `Port ${port} allocated`);
            console.log(`📍 Allocated port: ${port}`);
            
            // Get download URL
            const downloadUrl = await this.getDownloadUrl(edition, version);
            this.updateProgress(serverId, 30, 'Starting download...');
            console.log(`📥 Downloading from: ${downloadUrl}`);
            
            // Download server jar
            await this.downloadFile(downloadUrl, path.join(serverDir, 'server.jar'));
            this.updateProgress(serverId, 50, 'Server jar downloaded');

            // Create configuration files
            await this.createConfigFiles(serverDir, { 
                motd, port, name: serverName, ram,
                gamemode, difficulty, maxPlayers, viewDistance, simulationDistance,
                pvp, spawnProtection, spawnAnimals, spawnMonsters, spawnNpcs,
                allowNether, allowEnd, allowFlight, whiteList, enforceWhitelist,
                enableCommandBlock, onlineMode
            });
            this.updateProgress(serverId, 60, 'Configuration files created');

            // Forge special handling
            if (edition === 'forge') {
                await this.installForge(serverDir);
                this.updateProgress(serverId, 70, 'Forge installation completed');
            }

            // First run setup
            await this.firstTimeSetup(serverDir, ram);
            this.updateProgress(serverId, 80, 'First-time setup completed');

            // Start server
            await this.startServer(serverDir, serverId, ram, port);
            this.updateProgress(serverId, 100, 'Server running successfully');

            // Save server configuration
            const serverConfig = {
                serverId,
                edition,
                version,
                motd,
                ram,
                serverName,
                port,
                directory: serverDir,
                gamemode,
                difficulty,
                maxPlayers,
                status: 'running',
                deployedAt: new Date(),
                loadingScreen: loadingScreen
            };
            
            this.activeServers.set(serverId, serverConfig);
            await this.saveServerConfig(serverDir, serverConfig);

            console.log(`✅ Server ${serverId} deployed successfully on port ${port}`);
            return { 
                success: true, 
                serverId, 
                port, 
                status: 'running',
                gamemode: gamemode,
                difficulty: difficulty,
                maxPlayers: maxPlayers,
                message: 'Server deployed successfully' 
            };

        } catch (error) {
            this.updateProgress(serverId, 0, `Deployment failed: ${error.message}`);
            console.error(`❌ Deployment failed for ${serverId}:`, error);
            await this.cleanupServer(serverId);
            return { 
                success: false, 
                error: error.message,
                message: 'Deployment failed' 
            };
        }
    }

    // LIVE LOG STREAMING
    setupLiveLogs(serverId, res) {
        const serverDir = path.join(this.baseDir, serverId);
        const logPath = path.join(serverDir, 'server.log');
        
        // Store the response object for this stream
        this.logStreams.set(serverId, res);
        
        // Set SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        
        let position = 0;
        
        const sendLogUpdate = async () => {
            try {
                const stats = await fs.stat(logPath);
                if (stats.size < position) {
                    position = 0; // Log file was rotated
                }
                
                if (stats.size > position) {
                    const fd = await fs.open(logPath, 'r');
                    const buffer = Buffer.alloc(stats.size - position);
                    await fd.read(buffer, 0, stats.size - position, position);
                    await fd.close();
                    
                    const newLines = buffer.toString('utf8');
                    res.write(`data: ${JSON.stringify({ lines: newLines, timestamp: new Date().toISOString() })}\n\n`);
                    
                    position = stats.size;
                }
            } catch (error) {
                console.error('Log streaming error:', error);
            }
        };
        
        // Initial read of existing logs
        sendLogUpdate();
        
        // Watch for new logs every second
        const interval = setInterval(sendLogUpdate, 1000);
        
        // Cleanup on client disconnect
        res.on('close', () => {
            clearInterval(interval);
            this.logStreams.delete(serverId);
            console.log(`📊 Live logs disconnected for server: ${serverId}`);
        });
    }

    // TERMINAL COMMAND EXECUTION
    async executeCommand(serverId, command) {
        try {
            // Sanitize dangerous commands
            const dangerousCommands = ['rm', 'sudo', 'sh', 'bash', '>', '|', '&', ';', '`', '$', '../'];
            if (dangerousCommands.some(cmd => command.includes(cmd))) {
                throw new Error('Potentially dangerous command rejected');
            }
            
            // Method 1: Send to screen session
            const screenCmd = `screen -S ${serverId} -p 0 -X stuff "${command.replace(/"/g, '\\"')}\\n"`;
            await execAsync(screenCmd);
            
            console.log(`✅ Command executed on server ${serverId}: ${command}`);
            return { success: true, command, message: 'Command executed successfully' };
            
        } catch (error) {
            console.error(`❌ Failed to execute command on server ${serverId}:`, error);
            throw error;
        }
    }

    // DEPLOYMENT PROGRESS TRACKING
    updateProgress(serverId, percent, message) {
        this.deployProgress.set(serverId, { percent, message, timestamp: new Date() });
        console.log(`📊 [${serverId}] ${percent}% - ${message}`);
    }

    getProgress(serverId) {
        return this.deployProgress.get(serverId) || { percent: 0, message: 'Not found' };
    }

    // VALIDATION
    async validateConfig(config) {
        const supportedEditions = ['vanilla', 'paper', 'fabric', 'forge'];
        const supportedGamemodes = ['survival', 'creative', 'adventure', 'spectator'];
        const supportedDifficulties = ['peaceful', 'easy', 'normal', 'hard'];
        
        if (!supportedEditions.includes(config.edition)) {
            throw new Error(`Unsupported edition: ${config.edition}`);
        }
        
        if (config.gamemode && !supportedGamemodes.includes(config.gamemode)) {
            throw new Error(`Unsupported gamemode: ${config.gamemode}`);
        }
        
        if (config.difficulty && !supportedDifficulties.includes(config.difficulty)) {
            throw new Error(`Unsupported difficulty: ${config.difficulty}`);
        }
        
        if (config.ram < 1 || config.ram > (process.env.MINECRAFT_MAX_RAM || 8)) {
            throw new Error(`RAM must be between 1 and ${process.env.MINECRAFT_MAX_RAM || 8} GB`);
        }
    }

    // LOADING SCREEN
    async showLoadingScreen(loadingScreen, serverId) {
        console.log(`🔄 ${loadingScreen.message}`);
        
        if (loadingScreen.type === 'percentage' && loadingScreen.percentage) {
            const steps = loadingScreen.percentage;
            for (let i = 0; i <= steps; i++) {
                const percent = Math.round((i / steps) * 100);
                process.stdout.write(`\r📊 Loading: ${percent}% [${'█'.repeat(i)}${'░'.repeat(steps - i)}]`);
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            console.log('\n');
        } else if (loadingScreen.type === 'custom') {
            const frames = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
            for (let i = 0; i < 24; i++) {
                process.stdout.write(`\r${frames[i % frames.length]} ${loadingScreen.message}`);
                await new Promise(resolve => setTimeout(resolve, 125));
            }
            console.log('\n');
        }
    }

    // JAVA CHECK
    async checkJavaInstallation() {
        try {
            await execAsync('java -version');
            console.log('✅ Java is installed');
        } catch (error) {
            throw new Error('Java not installed. Run: sudo apt install openjdk-17-jdk');
        }
    }

    // PORT ALLOCATION
    async findAvailablePort() {
        for (let port = this.portStart; port <= this.portEnd; port++) {
            if (await this.isPortAvailable(port)) {
                return port;
            }
        }
        throw new Error('No available ports found');
    }

    async isPortAvailable(port) {
        return new Promise((resolve) => {
            const net = require('net');
            const tester = net.createServer();
            
            tester.once('error', () => resolve(false));
            tester.once('listening', () => {
                tester.close(() => resolve(true));
            });
            tester.listen(port, '0.0.0.0');
        });
    }

    // DOWNLOAD URL MANAGEMENT
    async getDownloadUrl(edition, version) {
        const urls = {
            // Paper URLs
            'paper-1.21.1': 'https://api.papermc.io/v2/projects/paper/versions/1.21.1/builds/306/downloads/paper-1.21.1-306.jar',
            'paper-1.21': 'https://api.papermc.io/v2/projects/paper/versions/1.21/builds/306/downloads/paper-1.21-306.jar',
            'paper-1.20.4': 'https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/526/downloads/paper-1.20.4-526.jar',
            'paper-1.20.1': 'https://api.papermc.io/v2/projects/paper/versions/1.20.1/builds/196/downloads/paper-1.20.1-196.jar',
            
            // Vanilla URLs
            'vanilla-1.21.1': 'https://piston-data.mojang.com/v1/objects/5b868151bd02b41319f54c8d4061b8cae84e664c/server.jar',
            'vanilla-1.21': 'https://piston-data.mojang.com/v1/objects/51c9b061ad06682e6e8b3b8df5bb6edac8130a0a/server.jar',
            'vanilla-1.20.1': 'https://piston-data.mojang.com/v1/objects/15c777e2cfe0556eef19aab534b186c0c6f277e1/server.jar',
            
            // Fabric URLs
            'fabric-1.21.1': 'https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.15.7/0.15.7/server/jar',
            'fabric-1.21': 'https://meta.fabricmc.net/v2/versions/loader/1.21/0.15.7/0.15.7/server/jar',
            'fabric-1.20.1': 'https://meta.fabricmc.net/v2/versions/loader/1.20.1/0.15.7/0.15.7/server/jar',
            
            // Forge URLs
            'forge-1.21.1': 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-48.0.1/forge-1.21.1-48.0.1-installer.jar',
            'forge-1.21': 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.21-48.0.0/forge-1.21-48.0.0-installer.jar',
            'forge-1.20.1': 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar'
        };
        
        const key = `${edition}-${version}`;
        if (urls[key]) {
            return urls[key];
        }
        
        throw new Error(`Unsupported edition/version: ${edition} ${version}`);
    }

    // FILE DOWNLOAD
    async downloadFile(url, filePath) {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            timeout: 120000
        });

        const writer = require('fs').createWriteStream(filePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
            response.data.on('error', reject);
        });
    }

    // CONFIGURATION FILES
    async createConfigFiles(serverDir, config) {
        // eula.txt
        await fs.writeFile(path.join(serverDir, 'eula.txt'), 'eula=true\n');

        // server.properties
        const properties = `
# Minecraft Server Properties
motd=${config.motd}
server-port=${config.port}
max-players=${config.maxPlayers}
level-name=${config.name}
gamemode=${config.gamemode}
difficulty=${config.difficulty}
view-distance=${config.viewDistance}
simulation-distance=${config.simulationDistance}
pvp=${config.pvp}
spawn-protection=${config.spawnProtection}
spawn-animals=${config.spawnAnimals}
spawn-monsters=${config.spawnMonsters}
spawn-npcs=${config.spawnNpcs}
allow-nether=${config.allowNether}
allow-end=${config.allowEnd}
allow-flight=${config.allowFlight}
white-list=${config.whiteList}
enforce-whitelist=${config.enforceWhitelist}
enable-command-block=${config.enableCommandBlock}
online-mode=${config.onlineMode}
level-type=default
max-world-size=29999984
max-build-height=256
use-native-transport=true
enable-status=true
enable-query=false
query.port=${config.port}
prevent-proxy-connections=false
sync-chunk-writes=true
rate-limit=0
hardcore=false
        `.trim();

        await fs.writeFile(path.join(serverDir, 'server.properties'), properties);

        // ops.json
        const ops = [{
            uuid: this.generateUUID(),
            name: "Admin",
            level: 4,
            bypassesPlayerLimit: true
        }];
        await fs.writeFile(path.join(serverDir, 'ops.json'), JSON.stringify(ops, null, 2));

        // whitelist.json if enabled
        if (config.whiteList) {
            const whitelist = [{
                uuid: this.generateUUID(),
                name: "TrustedPlayer"
            }];
            await fs.writeFile(path.join(serverDir, 'whitelist.json'), JSON.stringify(whitelist, null, 2));
        }

        // start.sh
        const startScript = `#!/bin/bash
cd "${serverDir}"
echo "Starting Minecraft ${config.gamemode} server..."
java -Xmx${config.ram}G -Xms1G -jar server.jar nogui
`;
        await fs.writeFile(path.join(serverDir, 'start.sh'), startScript);
        await fs.chmod(path.join(serverDir, 'start.sh'), 0o755);
    }

    // FORGE INSTALLATION
    async installForge(serverDir) {
        console.log('Installing Forge server...');
        await execAsync(`cd "${serverDir}" && java -jar server.jar --installServer`);
        
        const files = await fs.readdir(serverDir);
        const forgeJar = files.find(f => f.includes('forge') && f.endsWith('.jar') && !f.includes('installer'));
        
        if (forgeJar) {
            await fs.rename(path.join(serverDir, forgeJar), path.join(serverDir, 'server.jar'));
        }
        console.log('Forge installation completed');
    }

    // FIRST TIME SETUP
    async firstTimeSetup(serverDir, ram) {
        console.log('Running first-time setup...');
        try {
            await execAsync(`cd "${serverDir}" && timeout 30 java -Xmx${ram}G -Xms1G -jar server.jar nogui || true`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
            console.log('First run completed');
        }
    }

    // SERVER STARTUP
    async startServer(serverDir, serverId, ram, port) {
        console.log('Starting Minecraft server...');
        
        const startCmd = `cd "${serverDir}" && nohup java -Xmx${ram}G -Xms1G -jar server.jar nogui > server.log 2>&1 & echo $! > server.pid`;
        await execAsync(startCmd);
        
        await new Promise(resolve => setTimeout(resolve, 30000));
        
        try {
            const logContent = await fs.readFile(path.join(serverDir, 'server.log'), 'utf8');
            
            if (logContent.includes('Done') && logContent.includes('help')) {
                console.log('✅ Server started successfully!');
                return;
            }
            
            if (logContent.includes('ERROR')) {
                throw new Error('Server startup failed - check server.log');
            }
            
            if (await this.isPortListening(port)) {
                console.log('✅ Server is listening on port', port);
                return;
            }
            
            throw new Error('Server started but not fully ready');
            
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new Error('Server log file not created - server failed to start');
            }
            throw error;
        }
    }

    async isPortListening(port) {
        return new Promise((resolve) => {
            const net = require('net');
            const socket = new net.Socket();
            socket.setTimeout(2000);
            socket.on('connect', () => { socket.destroy(); resolve(true); });
            socket.on('timeout', () => { socket.destroy(); resolve(false); });
            socket.on('error', () => resolve(false));
            socket.connect(port, '127.0.0.1');
        });
    }

    // SERVER MANAGEMENT
    async stopServer(serverId) {
        try {
            console.log(`🛑 Stopping server: ${serverId}`);
            const serverDir = path.join(this.baseDir, serverId);
            
            // Try PID file
            try {
                const pid = await fs.readFile(path.join(serverDir, 'server.pid'), 'utf8');
                process.kill(parseInt(pid.trim()), 'SIGTERM');
                await new Promise(resolve => setTimeout(resolve, 3000));
            } catch (pidError) {
                // Ignore
            }
            
            // Kill by process
            await execAsync('killall java 2>/dev/null || true', { timeout: 5000 });
            
            // Kill by port
            try {
                const port = await this.getServerPort(serverDir);
                await execAsync(`fuser -k ${port}/tcp 2>/dev/null || true`, { timeout: 5000 });
            } catch (e) {
                // Ignore
            }
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            const isRunning = await this.isServerRunning(serverId);
            if (!isRunning) {
                this.activeServers.delete(serverId);
                console.log(`✅ Stopped server: ${serverId}`);
                return true;
            }
            
            return false;
            
        } catch (error) {
            console.error(`❌ Failed to stop server ${serverId}:`, error.message);
            return false;
        }
    }

    async restartServer(serverId) {
        try {
            console.log(`🔄 Restarting server: ${serverId}`);
            
            let serverConfig = this.activeServers.get(serverId);
            const serverDir = path.join(this.baseDir, serverId);
            
            if (!serverConfig) {
                const configPath = path.join(serverDir, 'server.config.json');
                const configData = await fs.readFile(configPath, 'utf8');
                serverConfig = JSON.parse(configData);
            }

            await this.stopServer(serverId);
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            const isRunning = await this.isServerRunning(serverId);
            if (isRunning) throw new Error('Server failed to stop');
            
            await this.startServer(serverDir, serverId, serverConfig.ram, serverConfig.port);
            
            serverConfig.status = 'running';
            serverConfig.restartedAt = new Date();
            this.activeServers.set(serverId, serverConfig);
            
            console.log(`✅ Server ${serverId} restarted successfully`);
            return true;
            
        } catch (error) {
            console.error(`❌ Failed to restart server ${serverId}:`, error);
            throw error;
        }
    }

    async deleteServer(serverId) {
        try {
            await this.stopServer(serverId);
            const serverDir = path.join(this.baseDir, serverId);
            await fs.rm(serverDir, { recursive: true, force: true });
            this.activeServers.delete(serverId);
            console.log(`🗑️ Deleted server: ${serverId}`);
            return true;
        } catch (error) {
            return false;
        }
    }

    async cleanupServer(serverId) {
        try {
            const serverDir = path.join(this.baseDir, serverId);
            await execAsync('killall java 2>/dev/null || true');
            await fs.rm(serverDir, { recursive: true, force: true });
            this.activeServers.delete(serverId);
            console.log(`🧹 Cleaned up server: ${serverId}`);
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }

    // PLAYER MANAGEMENT
    async addPlayer(serverId, playerName, playerUuid = null, opLevel = 0) {
        try {
            const serverDir = path.join(this.baseDir, serverId);
            const uuid = playerUuid || this.generateUUID();
            
            // Add to whitelist
            let whitelist = [];
            try {
                const data = await fs.readFile(path.join(serverDir, 'whitelist.json'), 'utf8');
                whitelist = JSON.parse(data);
            } catch (error) {}
            
            if (whitelist.find(p => p.name === playerName)) {
                throw new Error(`Player ${playerName} already in whitelist`);
            }
            
            whitelist.push({ uuid, name: playerName });
            await fs.writeFile(path.join(serverDir, 'whitelist.json'), JSON.stringify(whitelist, null, 2));
            
            // Add to ops if needed
            if (opLevel > 0) {
                let ops = [];
                try {
                    const data = await fs.readFile(path.join(serverDir, 'ops.json'), 'utf8');
                    ops = JSON.parse(data);
                } catch (error) {}
                
                ops.push({ uuid, name: playerName, level: opLevel, bypassesPlayerLimit: opLevel >= 4 });
                await fs.writeFile(path.join(serverDir, 'ops.json'), JSON.stringify(ops, null, 2));
            }
            
            console.log(`✅ Player ${playerName} added to server ${serverId}`);
            return { success: true, playerName, opLevel, message: 'Player added successfully' };
            
        } catch (error) {
            console.error(`❌ Failed to add player:`, error);
            throw error;
        }
    }

    async removePlayer(serverId, playerName) {
        try {
            const serverDir = path.join(this.baseDir, serverId);
            
            // Remove from whitelist
            let whitelist = [];
            try {
                const data = await fs.readFile(path.join(serverDir, 'whitelist.json'), 'utf8');
                whitelist = JSON.parse(data);
            } catch (error) {
                throw new Error('Whitelist file not found');
            }
            
            const playerIndex = whitelist.findIndex(p => p.name === playerName);
            if (playerIndex === -1) throw new Error(`Player ${playerName} not found`);
            
            const playerUuid = whitelist[playerIndex].uuid;
            whitelist.splice(playerIndex, 1);
            await fs.writeFile(path.join(serverDir, 'whitelist.json'), JSON.stringify(whitelist, null, 2));
            
            // Remove from ops
            try {
                const data = await fs.readFile(path.join(serverDir, 'ops.json'), 'utf8');
                let ops = JSON.parse(data);
                ops = ops.filter(p => p.uuid !== playerUuid);
                await fs.writeFile(path.join(serverDir, 'ops.json'), JSON.stringify(ops, null, 2));
            } catch (error) {}
            
            console.log(`✅ Player ${playerName} removed from server ${serverId}`);
            return { success: true, playerName, message: 'Player removed successfully' };
            
        } catch (error) {
            console.error(`❌ Failed to remove player:`, error);
            throw error;
        }
    }

    async listPlayers(serverId) {
        try {
            const serverDir = path.join(this.baseDir, serverId);
            
            let whitelist = [];
            let ops = [];
            
            try {
                const data = await fs.readFile(path.join(serverDir, 'whitelist.json'), 'utf8');
                whitelist = JSON.parse(data);
            } catch (error) {}
            
            try {
                const data = await fs.readFile(path.join(serverDir, 'ops.json'), 'utf8');
                ops = JSON.parse(data);
            } catch (error) {}
            
            const players = whitelist.map(player => {
                const op = ops.find(o => o.uuid === player.uuid);
                return {
                    name: player.name,
                    uuid: player.uuid,
                    opLevel: op ? op.level : 0,
                    isOp: !!op
                };
            });
            
            return players;
            
        } catch (error) {
            console.error(`❌ Failed to list players:`, error);
            throw error;
        }
    }

    // MOD MANAGEMENT
    async addMod(serverId, modUrl, modName = null) {
        try {
            const serverDir = path.join(this.baseDir, serverId);
            const modsDir = path.join(serverDir, 'mods');
            await fs.mkdir(modsDir, { recursive: true });
            
            const fileName = modName || modUrl.split('/').pop();
            const modPath = path.join(modsDir, fileName.endsWith('.jar') ? fileName : fileName + '.jar');
            
            // Check if mod exists
            try {
                await fs.access(modPath);
                throw new Error(`Mod ${fileName} already exists`);
            } catch (error) {}
            
            // Download mod
            const response = await axios({
                method: 'GET',
                url: modUrl,
                responseType: 'stream',
                timeout: 60000,
                maxContentLength: 100 * 1024 * 1024
            });
            
            const writer = fs.createWriteStream(modPath);
            response.data.pipe(writer);
            
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            
            // Validate JAR
            const buffer = Buffer.alloc(4);
            const fd = await fs.open(modPath, 'r');
            await fd.read(buffer, 0, 4, 0);
            await fd.close();
            
            if (buffer.readUInt32BE(0) !== 0x504b0304) {
                await fs.unlink(modPath);
                throw new Error('Downloaded file is not a valid JAR file');
            }
            
            console.log(`✅ Mod ${fileName} added to server ${serverId}`);
            return { success: true, modName: fileName, message: 'Mod installed successfully' };
            
        } catch (error) {
            console.error(`❌ Failed to add mod:`, error);
            throw error;
        }
    }

    async listMods(serverId) {
        try {
            const serverDir = path.join(this.baseDir, serverId);
            const modsDir = path.join(serverDir, 'mods');
            
            try {
                await fs.access(modsDir);
            } catch (error) {
                return [];
            }
            
            const files = await fs.readdir(modsDir);
            const mods = files.filter(file => file.endsWith('.jar'));
            
            const modsInfo = await Promise.all(
                mods.map(async (modFile) => {
                    const modPath = path.join(modsDir, modFile);
                    const stats = await fs.stat(modPath);
                    return {
                        name: modFile,
                        size: stats.size,
                        modified: stats.mtime
                    };
                })
            );
            
            return modsInfo;
            
        } catch (error) {
            console.error(`❌ Failed to list mods:`, error);
            throw error;
        }
    }

    async deleteMod(serverId, modName) {
        try {
            const serverDir = path.join(this.baseDir, serverId);
            const modPath = path.join(serverDir, 'mods', modName);
            
            await fs.access(modPath);
            await fs.unlink(modPath);
            
            console.log(`✅ Mod ${modName} deleted from server ${serverId}`);
            return { success: true, message: `Mod ${modName} deleted successfully` };
            
        } catch (error) {
            console.error(`❌ Failed to delete mod:`, error);
            throw error;
        }
    }

    // SERVER SETTINGS
    async updateServerSettings(serverId, settings) {
        try {
            const serverDir = path.join(this.baseDir, serverId);
            const propertiesPath = path.join(serverDir, 'server.properties');
            
            let properties = await fs.readFile(propertiesPath, 'utf8');
            
            Object.keys(settings).forEach(key => {
                const value = settings[key];
                const regex = new RegExp(`^${key}=.*`, 'm');
                
                if (regex.test(properties)) {
                    properties = properties.replace(regex, `${key}=${value}`);
                } else {
                    properties += `\n${key}=${value}`;
                }
            });
            
            await fs.writeFile(propertiesPath, properties);
            console.log(`✅ Server settings updated for ${serverId}`);
            return { success: true, settings, message: 'Server settings updated' };
            
        } catch (error) {
            console.error(`❌ Failed to update settings:`, error);
            throw error;
        }
    }

    // HELPER METHODS
    async isServerRunning(serverId) {
        try {
            const serverDir = path.join(this.baseDir, serverId);
            const port = await this.getServerPort(serverDir);
            const portAvailable = await this.isPortAvailable(port);
            
            const { stdout } = await execAsync(`ps aux | grep "java" | grep "${serverDir}" | grep -v grep | wc -l`);
            const processCount = parseInt(stdout.trim());
            
            return !portAvailable || processCount > 0;
        } catch (error) {
            return false;
        }
    }

    async getServerPort(serverDir) {
        try {
            const properties = await fs.readFile(path.join(serverDir, 'server.properties'), 'utf8');
            const portMatch = properties.match(/server-port=(\d+)/);
            return portMatch ? parseInt(portMatch[1]) : 25565;
        } catch (error) {
            return 25565;
        }
    }

    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    async saveServerConfig(serverDir, config) {
        const configPath = path.join(serverDir, 'server.config.json');
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    }

    // STATUS METHODS
    getServerStatus(serverId) {
        const server = this.activeServers.get(serverId);
        return server ? server.status : 'not_found';
    }

    getAllServers() {
        return Array.from(this.activeServers.values());
    }

    // VERSION MANAGEMENT
    async getAvailableVersions(edition) {
        const versions = {
            paper: ['1.21.1', '1.21', '1.20.4', '1.20.1', '1.19.4'],
            vanilla: ['1.21.1', '1.21', '1.20.4', '1.20.1', '1.19.4'],
            fabric: ['1.21.1', '1.21', '1.20.4', '1.20.1', '1.19.4'],
            forge: ['1.21.1', '1.21', '1.20.4', '1.20.1', '1.19.4']
        };
        
        return versions[edition] || [];
    }
}

module.exports = new DeployEngine();
