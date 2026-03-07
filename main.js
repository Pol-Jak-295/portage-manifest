const { app, BrowserWindow, ipcMain } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch'); // Make sure this is installed

let mainWindow;

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  
  // Remove the menu bar
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools(); // Uncomment for debugging
});

// Search handler
ipcMain.handle('search-packages', async (event, query) => {
  const results = [];
  
  // Search official repos
  try {
    const { stdout } = await execPromise(`pacman -Ss ${query}`);
    results.push(...parsePacmanOutput(stdout, 'official'));
  } catch (e) { console.log('pacman search failed', e); }
  
  // Search AUR (if yay is installed)
  try {
    const { stdout } = await execPromise(`yay -Ss ${query} 2>/dev/null`);
    results.push(...parsePacmanOutput(stdout, 'aur'));
  } catch (e) { console.log('AUR search failed', e); }
  
  // Search Flatpak
  try {
    const { stdout } = await execPromise(`flatpak search ${query}`);
    results.push(...parseFlatpakOutput(stdout));
  } catch (e) { console.log('Flatpak search failed', e); }
  
  return results;
});

// README fetch handler with fallbacks
ipcMain.handle('fetch-readme', async (event, pkg) => {
  console.log('Fetching README for:', pkg);
  
  // Try multiple sources, return first that works
  const readmeSources = [];
  
  if (pkg.source === 'aur') {
    readmeSources.push(
      `https://aur.archlinux.org/cgit/aur.git/plain/README?h=${pkg.name}`,
      `https://aur.archlinux.org/cgit/aur.git/plain/README.md?h=${pkg.name}`,
      `https://aur.archlinux.org/cgit/aur.git/plain/README.rst?h=${pkg.name}`
    );
    // Add upstream URLs
    const upstreamUrls = await getAURUpstreamUrls(pkg.name);
    readmeSources.push(...upstreamUrls.flat());
  }
  
  if (pkg.source === 'official') {
    readmeSources.push(
      `https://raw.githubusercontent.com/archlinux/svntogit-packages/master/${pkg.name}/trunk/README`,
      `https://raw.githubusercontent.com/archlinux/svntogit-packages/master/${pkg.name}/trunk/README.md`
    );
  }
  
  if (pkg.source === 'flatpak') {
    const flatpakId = pkg.flatpakId || pkg.name;
    readmeSources.push(
      `https://flathub.org/api/v2/appstream/${flatpakId}`,
      `https://raw.githubusercontent.com/flathub/${flatpakId}/master/README.md`,
      `https://raw.githubusercontent.com/flathub/${flatpakId}/master/README`
    );
  }
  
  // Try each source
  for (const source of readmeSources) {
    try {
      console.log('Trying:', source);
      const response = await fetch(source);
      
      if (response.ok) {
        if (source.includes('flathub.org/api')) {
          const data = await response.json();
          return data.description || data.summary || `# ${pkg.name}\n\nNo description available.`;
        } else {
          return await response.text();
        }
      }
    } catch (e) {
      console.log(`Failed to fetch from ${source}:`, e.message);
    }
  }
  
  return generateBasicReadme(pkg);
});

// GTK CSS handler
ipcMain.handle('get-gtk-css', () => {
  const possiblePaths = [
    path.join(process.env.HOME, '.config/gtk-4.0/gtk.css'),
    path.join(process.env.HOME, '.config/gtk-3.0/gtk.css'),
    '/usr/share/themes/Adwaita/gtk-4.0/gtk.css',
    '/usr/share/themes/Default/gtk-4.0/gtk.css'
  ];
  
  for (const cssPath of possiblePaths) {
    try {
      if (fs.existsSync(cssPath)) {
        return fs.readFileSync(cssPath, 'utf8');
      }
    } catch (e) {
      console.log(`Couldn't read ${cssPath}:`, e.message);
    }
  }
  return '';
});

// Helper functions
function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function parsePacmanOutput(output, source) {
  const lines = output.split('\n');
  const results = [];
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(' ')) continue;
    
    const match = lines[i].match(/^([^\/]+)\/([^ ]+) (.+)$/);
    if (match) {
      const [_, repo, fullName, version] = match;
      const description = lines[i+1]?.trim() || '';
      
      results.push({
        repo,
        name: fullName,
        version,
        description,
        source
      });
    }
  }
  
  return results;
}

function parseFlatpakOutput(output) {
  const results = [];
  const lines = output.split('\n').slice(1);
  
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length >= 3) {
      results.push({
        name: parts[0],
        version: parts[1],
        description: parts[2],
        source: 'flatpak',
        flatpakId: parts[0]
      });
    }
  }
  
  return results;
}

async function getAURUpstreamUrls(pkgName) {
  const urls = [];
  try {
    const response = await fetch(`https://aur.archlinux.org/rpc/v5/info/${pkgName}`);
    const data = await response.json();
    
    if (data.results && data.results[0]) {
      const upstreamUrl = data.results[0].URL;
      if (upstreamUrl) {
        const rawUrls = convertToRawReadmeUrl(upstreamUrl);
        if (rawUrls.length) urls.push(...rawUrls);
      }
    }
  } catch (e) {
    console.log('Failed to fetch AUR upstream info:', e.message);
  }
  return urls;
}

function convertToRawReadmeUrl(url) {
  try {
    const urlObj = new URL(url);
    
    if (urlObj.hostname === 'github.com') {
      const parts = urlObj.pathname.split('/').filter(p => p);
      if (parts.length >= 2) {
        const [owner, repo] = parts;
        return [
          `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`,
          `https://raw.githubusercontent.com/${owner}/${repo}/master/README.md`,
          `https://raw.githubusercontent.com/${owner}/${repo}/main/README`,
          `https://raw.githubusercontent.com/${owner}/${repo}/master/README`
        ];
      }
    }
    
    if (urlObj.hostname === 'gitlab.com') {
      const parts = urlObj.pathname.split('/').filter(p => p);
      if (parts.length >= 2) {
        const [owner, repo] = parts;
        return [
          `https://gitlab.com/${owner}/${repo}/-/raw/main/README.md`,
          `https://gitlab.com/${owner}/${repo}/-/raw/master/README.md`
        ];
      }
    }
  } catch (e) {}
  return [];
}

function generateBasicReadme(pkg) {
  const installCmd = {
    'official': `sudo pacman -S ${pkg.name}`,
    'aur': `yay -S ${pkg.name}`,
    'flatpak': `flatpak install ${pkg.flatpakId || pkg.name}`
  }[pkg.source] || `# No install command for ${pkg.source}`;

  return `# ${pkg.name}

Package from **${pkg.source}** repository.

## Description
${pkg.description || 'No description available.'}

## Installation
\`\`\`bash
${installCmd}
\`\`\`

## Version
${pkg.version || 'Unknown'}

---
*Generated by Portage Manifest*
`;
}

// Make sure node-fetch is installed
// Run: npm install node-fetch@2
