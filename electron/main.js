import { app, BrowserWindow, shell, Menu } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

let server = null;
let serverPort = null;
let mainWindow = null;

function startLocalServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let reqPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      if (reqPath === '/' || reqPath === '') {
        reqPath = '/index.html';
      }

      const filePath = path.normalize(path.join(publicDir, reqPath));

      // Security check: ensure path is within publicDir
      if (!filePath.startsWith(publicDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache'
        });
        fs.createReadStream(filePath).pipe(res);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve(serverPort);
    });

    server.on('error', reject);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 800,
    minHeight: 600,
    title: 'tex2md_live — LaTeX を Obsidian Markdown に',
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/index.html`);

  // Open external links in user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Windows Menu configuration
  const menuTemplate = [
    {
      label: 'ファイル',
      submenu: [
        {
          label: '終了',
          accelerator: 'Alt+F4',
          click: () => app.quit()
        }
      ]
    },
    {
      label: '編集',
      submenu: [
        { label: '元に戻す', role: 'undo' },
        { label: 'やり直し', role: 'redo' },
        { type: 'separator' },
        { label: '切り取り', role: 'cut' },
        { label: 'コピー', role: 'copy' },
        { label: '貼り付け', role: 'paste' },
        { label: 'すべて選択', role: 'selectAll' }
      ]
    },
    {
      label: '表示',
      submenu: [
        { label: '再読み込み', accelerator: 'Ctrl+R', role: 'reload' },
        { label: '強制再読み込み', accelerator: 'Ctrl+Shift+R', role: 'forceReload' },
        { label: '開発者ツール', accelerator: 'Ctrl+Shift+I', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '実際のサイズ', role: 'resetZoom' },
        { label: '拡大', role: 'zoomIn' },
        { label: '縮小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全画面表示', role: 'togglefullscreen' }
      ]
    },
    {
      label: 'ヘルプ',
      submenu: [
        {
          label: 'GitHub リポジトリ',
          click: () => shell.openExternal('https://github.com/kmitsutani/tex2md_live')
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    await startLocalServer();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  } catch (err) {
    console.error('Failed to start local server:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (server) {
    server.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
