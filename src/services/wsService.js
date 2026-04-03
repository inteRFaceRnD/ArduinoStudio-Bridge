const http = require('http');
const { Server } = require('socket.io');
const { DeviceManager } = require('./deviceManager');

const ALLOWED_ORIGINS = new Set([
    'http://localhost:3000',
    'https://app.arduinostudio.com',
    'https://www.arduinostudio.com',
]);

class WebSocketService {
    constructor() {
        this.httpServer = null;
        this.socketIO = null;
        this.pollingInterval = null;
        this._connectedClients = 0;
        this.init();
        this.deviceManager = new DeviceManager(this);
        this.addEventHandlers();
    }

    _normalizeOrigin(origin) {
        if (typeof origin !== 'string' || !origin) return '';
        try {
            return new URL(origin).origin;
        } catch (_) {
            return '';
        }
    }

    _isLoopbackAddress(address) {
        if (typeof address !== 'string' || !address) return false;
        return address === '127.0.0.1'
            || address === '::1'
            || address === '::ffff:127.0.0.1';
    }

    _isTrustedClient(client) {
        const origin = this._normalizeOrigin(client?.handshake?.headers?.origin);
        const remoteAddress = client?.conn?.remoteAddress || client?.handshake?.address || '';
        return ALLOWED_ORIGINS.has(origin) && this._isLoopbackAddress(remoteAddress);
    }

    init() {
        this.httpServer = http.createServer();

        this.socketIO = new Server(this.httpServer, {
            cors: {
                origin: [...ALLOWED_ORIGINS],
                methods: ['GET', 'POST'],
            }
        });

        // Bind to loopback only — prevents connections from other machines on the LAN
        this.httpServer.listen(7545, '127.0.0.1', () => {
            console.log('Socket.IO server listening on 127.0.0.1:7545');
        });

        return this.socketIO;
    }

    wsMessage(msg_type, message) {
        this.socketIO.emit(msg_type, { message: message });
    }

    sendDeviceList(reducedArray) {
        this.socketIO.emit('device-list', reducedArray);
    }

    addEventHandlers() {
        this.socketIO.on('connection', (client) => {
            if (!this._isTrustedClient(client)) {
                client.emit('bridge-error', { message: 'Unauthorized bridge client.' });
                client.disconnect(true);
                return;
            }

            this._connectedClients++;

            // Immediate scan for new client
            this.deviceManager.getDeviceList();

            // Start polling only once (not per-connection — prevents multiple intervals)
            if (!this.pollingInterval) {
                this.pollingInterval = setInterval(() => this.deviceManager.getDeviceList(), 1500);
            }

            client.on('play', (data) => {
                if (!data || typeof data !== 'object') return;
                this.deviceManager.play(data);
            });

            client.on('firmata', (data) => {
                if (data !== undefined && typeof data !== 'object') return;
                this.deviceManager.firmata(data);
            });

            client.on('stop', () => {
                this.deviceManager.stop();
            });

            client.on('force-close-port', (data) => {
                if (!data || typeof data !== 'object') return;
                this.deviceManager.forceCloseAndFlash(data);
            });

            client.on('disconnect', () => {
                this._connectedClients--;
                // Stop polling when no clients are connected — avoids holding serial
                // enumeration state and wasting CPU with zero listeners
                if (this._connectedClients <= 0) {
                    this._connectedClients = 0;
                    clearInterval(this.pollingInterval);
                    this.pollingInterval = null;
                }
            });
        });
    }
}

module.exports = { WebSocketService };
