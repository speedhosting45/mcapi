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

      // Start server using nohup instead of screen
      await this.startServer(serverDir, serverId, ram);

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
    switch (edition) {
      case 'paper':
        return `https://api.papermc.io/v2/projects/paper/versions/1.20.1/builds/196/downloads/paper-1.20.1-196.jar`;

      case 'vanilla':
        const vanillaResponse = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json');
        const versionInfo = vanillaResponse.data.versions.find(v => v.id === version);
        const versionDetail = await axios.get(versionInfo.url);
        return versionDetail.data.downloads.server.url;

      case 'fabric':
        return `https://meta.fabricmc.net/v2/versions/loader/1.20.1/0.15.7/0.12.3/server/jar`;

      case 'forge':
        return `https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar`;

      default:
        throw new Error(`Unsupported edition: ${edition}`);
    }
  }

  async findAvailablePort() {
    for (let port = this.portStart; port <= this.portEnd; port++) {
      try {
        await execAsync(`netstat -tuln | grep :${port} || echo "free"`);
      } catch (error) {
        return port;
      }
    }
    throw new Error('No available ports found');
  }

  async downloadFile(url, filePath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      timeout: 60000
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
    // eula.txt
    await fs.writeFile(path.join(serverDir, 'eula.txt'), 'eula=true\n');

    // server.properties
    const properties = `
# Minecraft server properties
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
rcon.port=${config.port + 1}
rcon.password=password
    `.trim();

    await fs.writeFile(path.join(serverDir, 'server.properties'), properties);

    // Create start script
    const startScript = `#!/bin/bash
cd "${serverDir}"
while true; do
  java -Xmx${config.ram}G -Xms1G -jar server.jar nogui
  echo "Server crashed, restarting in 10 seconds..."
  sleep 10
done
`;
    await fs.writeFile(path.join(serverDir, 'start.sh'), startScript);
    await fs.chmod(path.join(serverDir, 'start.sh'), 0o755);
  }

  async installForge(serverDir) {
    console.log('Installing Forge server...');
    await execAsync(`cd "${serverDir}" && java -jar server.jar --installServer`);
    
    const files = await fs.readdir(serverDir);
    const forgeJar = files.find(f => f.includes('forge') && f.endsWith('.jar') && !f.includes('installer'));
    
    if (forgeJar) {
      await fs.rename(
        path.join(serverDir, forgeJar),
        path.join(serverDir, 'server.jar')
      );
    }
    console.log('Forge installation completed');
  }

  async startServer(serverDir, serverId, ram) {
    // Use nohup instead of screen for better compatibility
    const javaCmd = `java -Xmx${ram}G -Xms1G -jar server.jar nogui`;
    const nohupCmd = `cd "${serverDir}" && nohup bash start.sh > server.log 2>&1 & echo $! > server.pid`;
    
    await execAsync(nohupCmd);
    
    // Wait for server to start
    console.log('Waiting for server to start...');
    await new Promise(resolve => setTimeout(resolve, 20000));
    
    // Check if server process is running
    try {
      const pid = await fs.readFile(path.join(serverDir, 'server.pid'), 'utf8');
      await execAsync(`ps -p ${pid.trim()}`);
      console.log(`Server ${serverId} started successfully with PID: ${pid.trim()}`);
    } catch (error) {
      // Check if port is listening instead
      try {
        const { stdout } = await execAsync(`netstat -tuln | grep :${await this.getServerPort(serverDir)}`);
        if (stdout) {
          console.log(`Server ${serverId} is listening on port`);
          return;
        }
      } catch (e) {
        // Continue to error handling
      }
      
      // Check server.log for errors
      try {
        const log = await fs.readFile(path.join(serverDir, 'server.log'), 'utf8');
        if (log.includes('ERROR') || log.includes('Failed')) {
          throw new Error('Server startup failed. Check server.log for details.');
        }
      } catch (logError) {
        // Ignore log read errors
      }
      
      throw new Error('Server failed to start - process not found');
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

  async cleanupServer(serverId) {
    try {
      const serverDir = path.join(this.baseDir, serverId);
      
      // Kill process using PID file
      try {
        const pid = await fs.readFile(path.join(serverDir, 'server.pid'), 'utf8');
        await execAsync(`kill ${pid.trim()} 2>/dev/null || true`);
      } catch (e) {
        // If no PID file, try to kill by port
        try {
          const port = await this.getServerPort(serverDir);
          await execAsync(`fuser -k ${port}/tcp 2>/dev/null || true`);
        } catch (e2) {
          // Ignore kill errors
        }
      }
      
      await fs.rm(serverDir, { recursive: true, force: true });
      this.activeServers.delete(serverId);
      console.log(`Cleaned up server: ${serverId}`);
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }

  async stopServer(serverId) {
    try {
      const serverDir = path.join(this.baseDir, serverId);
      const pid = await fs.readFile(path.join(serverDir, 'server.pid'), 'utf8');
      await execAsync(`kill ${pid.trim()}`);
      this.activeServers.delete(serverId);
      console.log(`Stopped server: ${serverId}`);
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
      console.log(`Deleted server: ${serverId}`);
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
