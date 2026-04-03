// Handle Squirrel install/uninstall events on Windows (must be first)
if (require('electron-squirrel-startup')) {
    require('electron').app.quit();
    process.exit(0);
}

const { app } = require('electron');
const path = require('path');
const { AppInitializer } = require('./services/app-init');
const { WebSocketService } = require('./services/wsService');

app.setName('ArduinoStudio Bridge');

// Register custom URL protocol: arduinostudio://
// This lets the web app launch the bridge from the browser.
if (process.defaultApp) {
    // Dev mode — need to pass the script path so Electron resolves correctly
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('arduinostudio', process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient('arduinostudio');
}

// Prevent crash dialogs — log errors silently instead of showing scary popups
process.on('uncaughtException', (err) => {
    console.error('[Bridge] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('[Bridge] Unhandled rejection:', reason?.message || reason);
});

// Auto-updater — checks GitHub Releases every hour (Windows & macOS only)
if (app.isPackaged && process.platform !== 'linux') {
    const { updateElectronApp, UpdateSourceType } = require('update-electron-app');
    updateElectronApp({
        updateSource: {
            type: UpdateSourceType.ElectronPublicUpdateService,
            repo: 'inteRFaceRnD/ArduinoStudio-Bridge',
        },
        updateInterval: '1 hour',
        notifyUser: false, // we show our own tray notification
    });
}

// Create tray + single-instance lock
const application = new AppInitializer('ArduinoStudio Bridge');

// Prevent WebSocket server from starting if this is a duplicate instance
if (!application.isSecondInstance) {
    // Start WebSocket server on port 7545 when Electron is ready
    app.whenReady().then(() => {
        const wsService = new WebSocketService();
        console.log('ArduinoStudio Bridge started — WebSocket service running on port 7545.');
    });
}
