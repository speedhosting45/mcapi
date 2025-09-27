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

      // Create server directory
      const serverDir = path.join(this.baseDir, serverId);
      await fs.mkdir(serverDir, { recursive: true });

      // Allocate port
      const port = await this.findAvailablePort();
      console.log(`📍 Allocated port: ${port}`);
      
      // Get download URL
      const downloadUrl = await this.getDownloadUrl(edition, version);
      console.log(`📥 Downloading from: ${downloadUrl}`);
      
      // Download server jar
      await this.downloadFile(downloadUrl, path.join(serverDir, 'server.jar'));

      // Create configuration files
      await this.createConfigFiles(serverDir, { 
        motd: motd || 'A Minecraft Server', 
        port, 
        name: serverName || serverId,
        ram: ram || 2
      });

      // Forge special handling
      if (edition === 'forge') {
        await this.installForge(serverDir);
      }

      // First run - accept EULA and generate world
      await this.firstTimeSetup(serverDir, serverId, ram);

      // Start server
      await this.startServer(serverDir, serverId, ram, port);

      const serverInfo = {
        serverId,
        edition,
        version,
        port,
        ram,
        status: 'running',
        directory: serverDir,
        startedAt: new Date()
      };

      this.activeServers.set(serverId, serverInfo);

      console.log(`✅ Server ${serverId} deployed successfully on port ${port}`);
      return { 
        success: true, 
        serverId, 
        port, 
        status: 'running',
        message: 'Server deployed successfully' 
      };

    } catch (error) {
      console.error(`❌ Deployment failed for ${serverId}:`, error);
      
      // Cleanup failed deployment
      await this.cleanupServer(serverId);
      
      return { 
        success: false, 
        error: error.message,
        message: 'Deployment failed' 
      };
    }
  }

  async getDownloadUrl(edition, version) {
    // Use direct URLs to avoid API issues
    const urls = {
      'paper-1.20.1': 'https://api.papermc.io/v2/projects/paper/versions/1.20.1/builds/196/downloads/paper-1.20.1-196.jar',
      'vanilla-1.20.1': 'https://piston-data.mojang.com/v1/objects/15c777e2cfe0556eef19aab534b186c0c6f277e1/server.jar',
      'fabric-1.20.1': 'https://meta.fabricmc.net/v2/versions/loader/1.20.1/0.15.7/0.12.3/server/jar'
    };
    
    const key = `${edition}-${version}`;
    if (urls[key]) {
      return urls[key];
    }
    
    throw new Error(`Unsupported edition/version: ${edition} ${version}`);
  }

  async findAvailablePort() {
    // Simple sequential port assignment
    let port = this.portStart;
    let attempts = 0;
    
    while (port <= this.portEnd && attempts < 100) {
      if (await this.isPortAvailable(port)) {
        return port;
      }
      port++;
      attempts++;
    }
    throw new Error('No available ports found');
  }

  async isPortAvailable(port) {
    return new Promise((resolve) => {
      const net = require('net');
      const tester = net.createServer();
      
      tester.once('error', (err) => {
        resolve(false);
      });
      
      tester.once('listening', () => {
        tester.close(() => {
          resolve(true);
        });
      });
      
      tester.listen(port, '0.0.0.0');
    });
  }

  async downloadFile(url, filePath) {
    console.log('Downloading server jar...');
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

  async createConfigFiles(serverDir, config) {
    console.log('Creating configuration files...');
    
    // eula.txt - accept EULA automatically
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

    // Create start script
    const startScript = `#!/bin/bash
cd "${serverDir}"
echo "Starting Minecraft server..."
java -Xmx${config.ram}G -Xms1G -jar server.jar nogui
echo "Server stopped or crashed"
`;
    await fs.writeFile(path.join(serverDir, 'start.sh'), startScript);
    await fs.chmod(path.join(serverDir, 'start.sh'), 0o755);
  }

  async firstTimeSetup(serverDir, serverId, ram) {
    console.log('Running first-time setup...');
    
    // First run to generate world and accept EULA
    try {
      const javaCmd = `cd "${serverDir}" && timeout 30 java -Xmx${ram}G -Xms1G -jar server.jar nogui || true`;
      await execAsync(javaCmd);
      
      // Wait a bit for files to be written
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Check if server created necessary files
      const files = await fs.readdir(serverDir);
      console.log('Files in server directory:', files);
      
    } catch (error) {
      console.log('First run completed (expected to exit after setup)');
    }
  }

  async startServer(serverDir, serverId, ram, port) {
    console.log('Starting Minecraft server...');
    
    // Use nohup to run in background
    const startCmd = `cd "${serverDir}" && nohup java -Xmx${ram}G -Xms1G -jar server.jar nogui > server.log 2>&1 & echo $! > server.pid`;
    
    await execAsync(startCmd);
    
    // Wait for server to start
    console.log('Waiting for server to start...');
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    // Check if server is running by checking the log
    try {
      const logContent = await fs.readFile(path.join(serverDir, 'server.log'), 'utf8');
      console.log('Server log snippet:', logContent.substring(0, 500));
      
      if (logContent.includes('Done') && logContent.includes('For help, type "help"')) {
        console.log('✅ Server started successfully!');
        return;
      }
      
      if (logContent.includes('ERROR') || logContent.includes('Failed')) {
        throw new Error('Server startup failed. Check server.log for errors.');
      }
      
      // Check if port is listening
      const isPortListening = await this.isPortListening(port);
      if (isPortListening) {
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
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      
      socket.on('error', () => {
        resolve(false);
      });
      
      socket.connect(port, '127.0.0.1');
    });
  }

  async cleanupServer(serverId) {
    try {
      const serverDir = path.join(this.baseDir, serverId);
      
      // Kill process
      try {
        const pidFile = path.join(serverDir, 'server.pid');
        const pid = await fs.readFile(pidFile, 'utf8');
        await execAsync(`kill ${pid.trim()} 2>/dev/null || true`);
      } catch (e) {
        // Ignore if no PID file
      }
      
      // Remove directory
      await fs.rm(serverDir, { recursive: true, force: true });
      this.activeServers.delete(serverId);
      console.log(`🧹 Cleaned up server: ${serverId}`);
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }

  async stopServer(serverId) {
    try {
      const serverDir = path.join(this.baseDir, serverId);
      const pidFile = path.join(serverDir, 'server.pid');
      const pid = await fs.readFile(pidFile, 'utf8');
      await execAsync(`kill ${pid.trim()}`);
      this.activeServers.delete(serverId);
      console.log(`⏹️ Stopped server: ${serverId}`);
      return true;
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

  getServerStatus(serverId) {
    const server = this.activeServers.get(serverId);
    return server ? server.status : 'not_found';
  }

  getAllServers() {
    return Array.from(this.activeServers.values());
  }
}

module.exports = new DeployEngine();
