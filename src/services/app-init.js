const { app, Tray, Menu, nativeImage, shell, autoUpdater, Notification } = require('electron');
const path = require('path');

/**
 * Resolve the tray icon — works in both dev and packaged (ASAR) mode.
 * In packaged mode, assets are in app.asar.unpacked (via asarUnpack in forge.config.js).
 */
function getIconPath() {
    // Windows needs .ico for crisp tray icon, macOS .icns, Linux .png
    const ext = process.platform === 'win32' ? 'favicon.ico'
        : process.platform === 'darwin' ? 'favicon.icns'
        : 'favicon.png';
    // In packaged mode, nativeImage.createFromPath reads ASAR transparently
    // so we don't need app.asar.unpacked — just point to the ASAR path
    return path.join(__dirname, '..', 'assets', ext);
}

class AppInitializer {
    constructor(name) {
        this._tray = null;
        this._status = 'Starting…';
        this._updateState = null; // null | 'checking' | 'available' | 'downloading' | 'ready'

        // Enforce single instance — second launch focuses the first
        const gotLock = app.requestSingleInstanceLock();
        this.isSecondInstance = !gotLock;
        if (!gotLock) {
            console.log('Another instance is already running — quitting.');
            app.quit();
            return;
        }

        this._appInit();
    }

    _appInit() {
        app.on('ready', () => {
            this._createTray();
            this._setStatus('Running');
            this._listenForUpdates();
        });

        // Handle arduinostudio:// protocol when app is already running (Windows/Linux)
        app.on('second-instance', (event, commandLine, workingDirectory) => {
            // Someone opened arduinostudio:// while the bridge is already running.
            // Nothing to do — the tray is already visible and WebSocket server is active.
            console.log('[Bridge] Protocol activation via second-instance:', commandLine.join(' '));
        });

        // Handle arduinostudio:// protocol on macOS
        app.on('open-url', (event, url) => {
            event.preventDefault();
            console.log('[Bridge] Protocol activation via open-url:', url);
            // Bridge is already running if we receive this event
        });

        // macOS: tray-only app, stay alive with no windows open
        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') app.quit();
        });

        app.on('before-quit', () => {
            if (this._tray) {
                this._tray.destroy();
                this._tray = null;
            }
        });
    }

    _listenForUpdates() {
        // autoUpdater only works in packaged builds on Windows & macOS
        if (!app.isPackaged || process.platform === 'linux') return;

        autoUpdater.on('checking-for-update', () => {
            this._updateState = 'checking';
            this._buildMenu();
        });

        autoUpdater.on('update-available', () => {
            this._updateState = 'downloading';
            this._buildMenu();
            new Notification({
                title: 'ArduinoStudio Bridge',
                body: 'A new update is downloading in the background…',
            }).show();
        });

        autoUpdater.on('update-not-available', () => {
            this._updateState = null;
            this._buildMenu();
        });

        autoUpdater.on('update-downloaded', () => {
            this._updateState = 'ready';
            this._buildMenu();
            new Notification({
                title: 'ArduinoStudio Bridge',
                body: 'Update ready — click "Restart to Update" in the tray to apply.',
            }).show();
        });

        autoUpdater.on('error', (err) => {
            console.error('Auto-updater error:', err.message);
            this._updateState = null;
            this._buildMenu();
        });
    }

    _createTray() {
        const image = nativeImage.createFromPath(getIconPath());
        this._tray = new Tray(image);
        this._tray.setToolTip('ArduinoStudio Bridge');

        // macOS: tray-only — hide dock icon
        if (app.dock) {
            app.dock.setIcon(image);
            app.dock.hide();
        }

        this._buildMenu();
    }

    _setStatus(status) {
        this._status = status;
        this._buildMenu();
    }

    _buildMenu() {
        if (!this._tray) return;

        const launchOnStartup = app.getLoginItemSettings().openAtLogin;
        const canUpdate = app.isPackaged && process.platform !== 'linux';

        // Build update menu item based on current state
        let updateItem;
        if (this._updateState === 'ready') {
            updateItem = {
                label: 'Restart to Update',
                click: () => autoUpdater.quitAndInstall(),
            };
        } else if (this._updateState === 'downloading') {
            updateItem = { label: 'Downloading update…', enabled: false };
        } else if (this._updateState === 'checking') {
            updateItem = { label: 'Checking for updates…', enabled: false };
        } else {
            updateItem = {
                label: 'Check for Updates',
                enabled: canUpdate,
                click: () => {
                    if (canUpdate) autoUpdater.checkForUpdates();
                },
            };
        }

        const menu = Menu.buildFromTemplate([
            { label: 'ArduinoStudio Bridge', enabled: false },
            { label: `Status: ${this._status}`, enabled: false },
            { type: 'separator' },
            {
                label: 'Open ArduinoStudio',
                click: () => shell.openExternal('https://app.arduinostudio.com/dashboard'),
            },
            { type: 'separator' },
            updateItem,
            { type: 'separator' },
            {
                label: 'Launch at Login',
                type: 'checkbox',
                checked: launchOnStartup,
                click: (item) => {
                    app.setLoginItemSettings({ openAtLogin: item.checked });
                    this._buildMenu();
                },
            },
            { type: 'separator' },
            { label: 'Quit', role: 'quit' },
        ]);

        this._tray.setContextMenu(menu);
    }

    /** Call this from wsService to reflect connection state in tray */
    setStatus(status) {
        this._setStatus(status);
    }
}

module.exports = { AppInitializer };
