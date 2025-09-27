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
    }

    async deployServer(deployConfig) {
        const { serverId, edition, version, motd, ram, serverName } = deployConfig;

        try {
            console.log(`🚀 Starting deployment: ${serverId} (${edition} ${version})`);

            // Check Java
            await this.checkJavaInstallation();

            // Create directory
            const serverDir = path.join(this.baseDir, serverId);
            await fs.mkdir(serverDir, { recursive: true });

            // Allocate port
            const port = await this.findAvailablePort();
            console.log(`📍 Allocated port: ${port}`);
            
            // Download
            const downloadUrl = await this.getDownloadUrl(edition, version);
            console.log(`📥 Downloading from: ${downloadUrl}`);
            await this.downloadFile(downloadUrl, path.join(serverDir, 'server.jar'));

            // Config files
            await this.createConfigFiles(serverDir, { motd, port, name: serverName, ram });

            // Forge handling
            if (edition === 'forge') {
                await this.installForge(serverDir);
            }

            // First run setup
            await this.firstTimeSetup(serverDir, ram);

            // Start server
            await this.startServer(serverDir, serverId, ram, port);

            const serverInfo = {
                serverId, edition, version, port, ram,
                status: 'running', directory: serverDir, startedAt: new Date()
            };

            this.activeServers.set(serverId, serverInfo);

            console.log(`✅ Server ${serverId} deployed successfully on port ${port}`);
            return { success: true, serverId, port, status: 'running', message: 'Server deployed successfully' };

        } catch (error) {
            console.error(`❌ Deployment failed for ${serverId}:`, error);
            await this.cleanupServer(serverId);
            return { success: false, error: error.message, message: 'Deployment failed' };
        }
    }

    async checkJavaInstallation() {
        try {
            await execAsync('java -version');
            console.log('✅ Java is installed');
        } catch (error) {
            throw new Error('Java not installed. Run: sudo apt install openjdk-17-jdk');
        }
    }

async getDownloadUrl(edition, version) {
    const urls = {
        // Fabric URLs - using simpler direct approach
        'fabric-1.21': 'https://meta.fabricmc.net/v2/versions/loader/1.21/0.15.7/0.15.7/server/jar',
        'fabric-1.21.1': 'https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.15.7/0.15.7/server/jar',
        'fabric-1.20.1': 'https://meta.fabricmc.net/v2/versions/loader/1.20.1/0.15.7/0.15.7/server/jar',
        
        // Alternative: Use the installer which is more reliable
        'fabric-installer-1.21': 'https://meta.fabricmc.net/v2/versions/loader/1.21/0.15.7/0.15.7/profile/json',
        
        // Paper URLs (as backup)
        'paper-1.21': 'https://api.papermc.io/v2/projects/paper/versions/1.21/builds/130/downloads/paper-1.21-130.jar',
        'paper-1.20.1': 'https://api.papermc.io/v2/projects/paper/versions/1.20.1/builds/196/downloads/paper-1.20.1-196.jar',
        
        // Vanilla URLs
        'vanilla-1.21': 'https://piston-data.mojang.com/v1/objects/51c9b061ad06682e6e8b3b8df5bb6edac8130a0a/server.jar'
    };
    
    const key = `${edition}-${version}`;
    if (urls[key]) {
        return urls[key];
    }
    
    // If Fabric fails, try Paper as fallback
    const paperKey = `paper-${version}`;
    if (urls[paperKey]) {
        console.log(`Fabric ${version} not available, using Paper instead`);
        return urls[paperKey];
    }
    
    throw new Error(`Unsupported edition/version: ${edition} ${version}`);
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

    async downloadFile(url, filePath) {
        const response = await axios({ method: 'GET', url, responseType: 'stream', timeout: 120000 });
        const writer = require('fs').createWriteStream(filePath);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    }

    async createConfigFiles(serverDir, config) {
        // eula.txt
        await fs.writeFile(path.join(serverDir, 'eula.txt'), 'eula=true\n');

        // server.properties
        const properties = `
motd=${config.motd}
server-port=${config.port}
max-players=20
level-name=${config.name}
online-mode=false
enable-command-block=true
spawn-protection=0
difficulty=easy
gamemode=survival
view-distance=10
enable-rcon=false
        `.trim();
        await fs.writeFile(path.join(serverDir, 'server.properties'), properties);

        // start.sh
        const startScript = `#!/bin/bash
cd "${serverDir}"
java -Xmx${config.ram}G -Xms1G -jar server.jar nogui
`;
        await fs.writeFile(path.join(serverDir, 'start.sh'), startScript);
        await fs.chmod(path.join(serverDir, 'start.sh'), 0o755);
    }

    async firstTimeSetup(serverDir, ram) {
        try {
            await execAsync(`cd "${serverDir}" && timeout 30 java -Xmx${ram}G -Xms1G -jar server.jar nogui || true`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
            console.log('First run completed');
        }
    }

    async startServer(serverDir, serverId, ram, port) {
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

    async stopServer(serverId) {
    try {
        console.log(`🛑 Attempting to stop server: ${serverId}`);
        
        const serverDir = path.join(this.baseDir, serverId);
        
        // Method 1: Try gentle kill first
        try {
            const pidFile = path.join(serverDir, 'server.pid');
            const pid = await fs.readFile(pidFile, 'utf8');
            const cleanPid = pid.trim();
            
            if (cleanPid) {
                console.log(`Sending TERM signal to PID: ${cleanPid}`);
                process.kill(parseInt(cleanPid), 'SIGTERM');
                
                // Wait for graceful shutdown
                await new Promise(resolve => setTimeout(resolve, 5000));
                
                // Check if process is still running
                try {
                    process.kill(parseInt(cleanPid), 0);
                    console.log('Process still running, sending KILL signal');
                    process.kill(parseInt(cleanPid), 'SIGKILL');
                } catch (e) {
                    console.log('Process terminated successfully');
                }
            }
        } catch (pidError) {
            console.log('No PID file found');
        }
        
        // Method 2: Use child_process.exec with proper error handling
        try {
            console.log('Killing Java processes...');
            await this.safeExec('pkill -f "java.*server.jar"');
        } catch (e) {
            console.log('No Java processes found or error killing');
        }
        
        // Method 3: Kill by port
        try {
            const port = await this.getServerPort(serverDir);
            console.log(`Killing process on port ${port}`);
            await this.safeExec(`fuser -k ${port}/tcp 2>/dev/null`);
        } catch (e) {
            console.log('No process found on port');
        }
        
        // Method 4: Use killall as alternative
        try {
            await this.safeExec('killall java 2>/dev/null || true');
        } catch (e) {
            console.log('killall command failed or no processes found');
        }
        
        // Wait for processes to terminate
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Check if server is actually stopped
        const isRunning = await this.isServerRunning(serverId);
        
        if (!isRunning) {
            this.activeServers.delete(serverId);
            console.log(`✅ Successfully stopped server: ${serverId}`);
            return true;
        } else {
            console.log(`⚠️ Server might still be running`);
            return false;
        }
        
    } catch (error) {
        console.error(`❌ Error stopping server:`, error.message);
        return false;
    }
}

// Safe execution method that handles signals properly
async safeExec(command) {
    return new Promise((resolve, reject) => {
        const child = require('child_process').exec(command, (error, stdout, stderr) => {
            if (error) {
                // Ignore "no process found" errors
                if (error.code === 1 || error.signal === 'SIGTERM') {
                    resolve({ stdout, stderr });
                } else {
                    reject(error);
                }
            } else {
                resolve({ stdout, stderr });
            }
        });
        
        // Handle process termination
        process.on('SIGTERM', () => {
            child.kill('SIGTERM');
        });
    });
}

async isServerRunning(serverId) {
    try {
        // Check if any Java process is running
        const { stdout } = await execAsync('ps aux | grep "java" | grep -v grep | wc -l');
        const javaCount = parseInt(stdout.trim());
        
        // Check if our specific server directory has an active process
        const serverDir = path.join(this.baseDir, serverId);
        const { stdout: serverStdout } = await execAsync(`ps aux | grep "${serverDir}" | grep -v grep | wc -l`);
        const serverProcessCount = parseInt(serverStdout.trim());
        
        return javaCount > 0 || serverProcessCount > 0;
    } catch (error) {
        return false;
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
            await execAsync(`pkill -f "server.jar" || true`);
            await fs.rm(serverDir, { recursive: true, force: true });
            this.activeServers.delete(serverId);
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }

    getServerStatus(serverId) {
        const server = this.activeServers.get(serverId);
        return server ? server.status : 'not_found';
    }

    getAllServers() {
        return Array.from(this.activeServers.values());
    }
}

module.exports = new DeployEngine();
