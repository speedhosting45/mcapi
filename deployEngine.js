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
    
    this.activeServers = new Map(); // Track active servers
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
        name: serverName || serverId 
      });

      // Forge special handling
      if (edition === 'forge') {
        await this.installForge(serverDir);
      }

      // Start server
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
        const paperResponse = await axios.get(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds`);
        const latestBuild = paperResponse.data.builds[paperResponse.data.builds.length - 1];
        return `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${latestBuild.build}/downloads/paper-${version}-${latestBuild.build}.jar`;

      case 'vanilla':
        const vanillaResponse = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json');
        const versionInfo = vanillaResponse.data.versions.find(v => v.id === version);
        const versionDetail = await axios.get(versionInfo.url);
        return versionDetail.data.downloads.server.url;

      case 'fabric':
        const loaderResponse = await axios.get('https://meta.fabricmc.net/v2/versions/loader');
        const latestLoader = loaderResponse.data[0].version;
        return `https://meta.fabricmc.net/v2/versions/loader/${version}/${latestLoader}/0.12.3/server/jar`;

      case 'forge':
        // Simple Forge URL pattern
        return `https://maven.minecraftforge.net/net/minecraftforge/forge/${version}-49.0.1/forge-${version}-49.0.1-installer.jar`;

      default:
        throw new Error(`Unsupported edition: ${edition}`);
    }
  }

  async findAvailablePort() {
    for (let port = this.portStart; port <= this.portEnd; port++) {
      try {
        await execAsync(`lsof -i:${port}`);
      } catch (error) {
        // Port is available if command fails
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
      timeout: 30000
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
    `.trim();

    await fs.writeFile(path.join(serverDir, 'server.properties'), properties);

    // Create start script
    const startScript = `#!/bin/bash
cd "${serverDir}"
java -Xmx${process.env.MINECRAFT_MAX_RAM || 2}G -Xms1G -jar server.jar nogui
`;
    await fs.writeFile(path.join(serverDir, 'start.sh'), startScript);
    await fs.chmod(path.join(serverDir, 'start.sh'), 0o755);
  }

  async installForge(serverDir) {
    console.log('Installing Forge server...');
    await execAsync(`cd "${serverDir}" && java -jar server.jar --installServer`);
    
    // Find and rename the Forge jar
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
    const javaCmd = `java -Xmx${ram}G -Xms1G -jar server.jar nogui`;
    const screenCmd = `screen -dmS ${serverId} bash -c 'cd "${serverDir}" && ${javaCmd} 2>&1 | tee server.log'`;
    
    await execAsync(screenCmd);
    
    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 15000));
    
    // Check if screen session is running
    const { stdout } = await execAsync(`screen -list | grep ${serverId} || echo "not found"`);
    if (stdout.includes('not found')) {
      throw new Error('Server failed to start - screen session not found');
    }
    
    console.log(`Server ${serverId} started successfully`);
  }

  async cleanupServer(serverId) {
    try {
      await execAsync(`screen -S ${serverId} -X quit`).catch(() => {});
      const serverDir = path.join(this.baseDir, serverId);
      await fs.rm(serverDir, { recursive: true, force: true });
      this.activeServers.delete(serverId);
      console.log(`Cleaned up server: ${serverId}`);
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }

  async stopServer(serverId) {
    try {
      await execAsync(`screen -S ${serverId} -X quit`);
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
