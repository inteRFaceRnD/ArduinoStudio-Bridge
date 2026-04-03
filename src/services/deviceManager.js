const { SerialPort } = require('serialport');
const { execFile } = require('child_process');
const { FirmataFlasher } = require('./firmata-service');
const { processComponent, getBoard, cleanupInstances, forceCloseBoard } = require('../board/boardFunctions');

const commonArduinoVids = [
    '2341', // Official Arduino
    '1A86', // Common for Arduino clones (CH340/CH341)
    '2A03', // Arduino.org
    '239A', // Adafruit Boards
    '0403', // FTDI, used in older Arduino boards and some clones
    '10C4', // Silicon Labs, used in CP210x USB to UART bridges
    '03EB',
];

const KNOWN_BLOCKERS = ['arduino', 'serialmon', 'putty', 'teraterm', 'coolterm', 'realterm'];

class DeviceManager {
    constructor(ws) {
        this.wsService = ws;
        this.boardsList = [];
        this.playRuns = new Map();
        this.flashingPorts = new Set();
        this._scanning = false;
        this._pendingPortLock = null;
    }

    _sanitizePid(value) {
        const normalized = `${value ?? ''}`.trim();
        return /^\d{1,10}$/.test(normalized) ? normalized : null;
    }

    _emitPlaybackEvent(payload) {
        this.wsService.socketIO.emit('playback-event', payload);
    }

    _createPlaybackClient(playback) {
        return {
            emit: (eventName, payload) => this.wsService.socketIO.emit(eventName, payload),
            playback,
        };
    }

    _abortRunsForPort(port, reason = 'disconnected') {
        let abortedAny = false;
        for (const run of this.playRuns.values()) {
            if (run.devicePort !== port) continue;
            run.stopReason = reason;
            run.controller.abort();
            abortedAny = true;
        }
        return abortedAny;
    }

    _abortActiveRuns({ silent = false, reason = 'stopped' } = {}) {
        const activeRuns = [...this.playRuns.values()];
        if (!activeRuns.length) return false;

        for (const run of activeRuns) {
            run.stopReason = reason;
            run.controller.abort();
        }

        cleanupInstances();

        if (!silent && reason === 'stopped') {
            this.wsService.wsMessage('general-message', 'Sequence stopped.');
        }

        return true;
    }

    getDeviceList = async () => {
        if (this._scanning) return;
        this._scanning = true;

        try {
            const ports = await SerialPort.list();
            const arduinoPorts = ports.filter(port =>
                commonArduinoVids.includes(port.vendorId?.toUpperCase())
            );
            const arduinoPortsSet = new Set(arduinoPorts.map(port => port.path));

            const stillConnected = [];
            let cleanedAfterDisconnect = false;

            for (const board of this.boardsList) {
                if (arduinoPortsSet.has(board.port)) {
                    stillConnected.push(board);
                    continue;
                }

                const abortedRun = this._abortRunsForPort(board.port, 'disconnected');
                if (abortedRun && !cleanedAfterDisconnect) {
                    cleanupInstances();
                    cleanedAfterDisconnect = true;
                }

                forceCloseBoard(board);
                this.wsService.wsMessage('general-message', `Board ${board.port} disconnected.`);
            }
            this.boardsList = stillConnected;

            for (const port of arduinoPorts) {
                const boardPath = port.path;
                if (this.flashingPorts.has(boardPath)) {
                    continue;
                }
                if (!this.boardsList.some(board => board.port === boardPath)) {
                    try {
                        const board = await getBoard(boardPath, this.wsService);
                        this.boardsList.push(board);
                    } catch (error) {
                        const msg = error.message || '';
                        if (msg.includes('Access denied') || msg.includes('EACCES') || msg.includes('EPERM')) {
                            console.log(`${boardPath} locked by another program (auto-scan).`);
                        } else if (msg.includes('timeout') || msg.includes('Timeout')) {
                            console.log(`Board at ${boardPath} detected but Firmata not responding (needs flash).`);
                        } else {
                            console.log(`Could not connect to board on ${boardPath}: ${msg}`);
                        }
                        console.error('Failed to initialize board at', boardPath, ':', msg);
                    }
                }
            }

            const reducedArray = arduinoPorts.map(port => ({
                port: port.path,
                firmataReady: this.boardsList.some(board => board.port === port.path),
            }));
            this.wsService.sendDeviceList(reducedArray);
        } catch (err) {
            console.error('Error listing serial ports:', err);
        } finally {
            this._scanning = false;
        }
    }

    getBoardByName(name) {
        return this.boardsList.find(board => board.port === name || board.name === name);
    }

    async play(data) {
        const sequences = Array.isArray(data?.sequences)
            ? data.sequences
            : (data?.sequence ? [data.sequence] : []);
        const requestedRunId = data?.runId || `run-${Date.now()}`;
        const deviceName = data?.deviceName;

        try {
            let board = this.getBoardByName(deviceName);
            if (!board) {
                board = this.boardsList[0];
            }

            if (!board) {
                this.wsService.wsMessage('general-message', 'No Arduino found. Please plug in your board and try again.');
                this._emitPlaybackEvent({ event: 'run-finished', runId: requestedRunId, status: 'error', reason: 'no-board' });
                return;
            }

            if (!board.isReady) {
                this.wsService.wsMessage('general-message', 'Your board isn\'t set up yet. Click the setup button to prepare it.');
                this._emitPlaybackEvent({ event: 'run-finished', runId: requestedRunId, status: 'error', reason: 'not-ready' });
                return;
            }

            const playableSequences = sequences
                .map(sequence => ({ sequence, firstComponent: sequence?.components?.[0] || null }))
                .filter(({ firstComponent }) => !!firstComponent);

            if (!playableSequences.length) {
                this.wsService.wsMessage('general-message', 'This sequence is empty. Drag some blocks onto the canvas first!');
                this._emitPlaybackEvent({ event: 'run-finished', runId: requestedRunId, status: 'error', reason: 'empty-sequence' });
                return;
            }

            if (this.playRuns.size) {
                this._abortActiveRuns({ silent: true, reason: 'superseded' });
            }

            cleanupInstances();

            const runBoardId = data?.boardId || playableSequences[0].sequence?.board || null;
            const controller = new AbortController();
            const signal = controller.signal;

            this.playRuns.set(requestedRunId, {
                controller,
                devicePort: board.port,
                stopReason: null,
            });

            const playbackClient = this._createPlaybackClient({
                runId: requestedRunId,
                boardId: runBoardId,
                devicePort: board.port,
            });

            this._emitPlaybackEvent({
                event: 'run-start',
                runId: requestedRunId,
                boardId: runBoardId,
                devicePort: board.port,
                sequenceIds: playableSequences.map(({ sequence }) => sequence._id),
            });

            await Promise.all(playableSequences.map(async ({ sequence, firstComponent }) => {
                this._emitPlaybackEvent({
                    event: 'sequence-start',
                    runId: requestedRunId,
                    boardId: sequence?.board || runBoardId,
                    sequenceId: sequence?._id || null,
                    devicePort: board.port,
                });

                await processComponent(firstComponent, playbackClient, signal, board);

                if (!signal.aborted) {
                    this._emitPlaybackEvent({
                        event: 'sequence-complete',
                        runId: requestedRunId,
                        boardId: sequence?.board || runBoardId,
                        sequenceId: sequence?._id || null,
                        devicePort: board.port,
                    });
                }
            }));

            const currentRun = this.playRuns.get(requestedRunId);
            const stopReason = currentRun?.stopReason || null;
            const finalStatus = signal.aborted
                ? (stopReason === 'disconnected' ? 'disconnected' : 'aborted')
                : 'completed';

            this._emitPlaybackEvent({
                event: 'run-finished',
                runId: requestedRunId,
                boardId: runBoardId,
                devicePort: board.port,
                status: finalStatus,
                reason: stopReason,
            });

            if (!signal.aborted) {
                console.log('Sequence execution complete.');
            }
        } catch (e) {
            const msg = e.message || '';
            if (msg.includes('not open') || msg.includes('ECONNREFUSED') || msg.includes('Cannot read') || msg.includes('not ready')) {
                this.wsService.wsMessage('general-message', 'Your board isn\'t responding. Try running the setup wizard again, or unplug and reconnect.');
            } else {
                this.wsService.wsMessage('general-message', 'Something went wrong. Try unplugging your Arduino and plugging it back in.');
            }
            this._emitPlaybackEvent({
                event: 'run-finished',
                runId: requestedRunId,
                status: 'error',
                reason: msg || 'play-error',
            });
            console.error('Play error:', e);
        } finally {
            this.playRuns.delete(requestedRunId);
        }
    }

    stop() {
        this._abortActiveRuns({ silent: false, reason: 'stopped' });
    }

    _closePort(port) {
        this._abortRunsForPort(port, 'port-close');
        cleanupInstances();
        for (const board of this.boardsList) {
            if (board.port === port) {
                forceCloseBoard(board);
            }
        }
        this.boardsList = this.boardsList.filter(board => board.port !== port);
    }

    async firmata(data, _isRetry = false) {
        this.stop();
        let port = data?.deviceName || null;
        let handoffToRetry = false;
        try {
            const board = port
                ? this.getBoardByName(port)
                : this.boardsList[0];

            port = port || board?.port || null;
            if (!port) {
                this.wsService.wsMessage('general-message', 'No board found. Please plug in your Arduino and try again.');
                return;
            }

            this.flashingPorts.add(port);

            this.wsService.socketIO.emit('flash-progress', { step: 'closing', port });

            this._closePort(port);
            await new Promise(resolve => setTimeout(resolve, 500));

            this.wsService.socketIO.emit('flash-progress', { step: 'flashing', port });

            await new Promise((resolve, reject) => {
                FirmataFlasher.flash(port, (error) => {
                    if (error) reject(error);
                    else resolve();
                }, data?.board);
            });

            this.wsService.socketIO.emit('flash-progress', { step: 'reconnecting', port });

            await new Promise(resolve => setTimeout(resolve, 3000));

            try {
                const newBoard = await getBoard(port, this.wsService);
                this.boardsList.push(newBoard);
                this.wsService.socketIO.emit('flash-progress', { step: 'done', port });
            } catch (e) {
                this.wsService.socketIO.emit('flash-progress', { step: 'done', port });
                this.wsService.wsMessage('general-message', 'Board reconnect failed. Try unplugging and reconnecting.');
            }
        } catch (e) {
            const msg = e.message || String(e);
            const isAccessDenied = msg.includes('Access denied') || msg.includes('EACCES') || msg.includes('EPERM');

            if (isAccessDenied && !_isRetry) {
                console.log(`Access denied on ${port} - closing bridge connections and retrying...`);
                this._closePort(port);
                await new Promise(resolve => setTimeout(resolve, 1500));
                handoffToRetry = true;
                return this.firmata(data, true);
            }

            this.wsService.socketIO.emit('flash-progress', { step: 'error', port: data?.deviceName || '' });

            if (isAccessDenied) {
                const port = data?.deviceName || '';
                this._pendingFlashData = data;
                this._findBlockingProcess(port);
            } else {
                this.wsService.wsMessage('general-message', 'Setup failed. Make sure you selected the right board model and try again.');
            }
            console.error('Firmata error:', e);
        } finally {
            if (port && !handoffToRetry) {
                this.flashingPorts.delete(port);
            }
        }
    }

    _findBlockingProcess(port) {
        execFile('tasklist', ['/FO', 'CSV', '/NH'], (err, stdout) => {
            let found = [];
            if (!err && stdout) {
                const lines = stdout.trim().split('\n');
                for (const line of lines) {
                    const parts = line.split('","');
                    if (parts.length < 2) continue;
                    const name = (parts[0] || '').replace(/"/g, '').toLowerCase();
                    const pid = this._sanitizePid((parts[1] || '').replace(/"/g, ''));
                    if (!pid) continue;
                    if (KNOWN_BLOCKERS.some(blocker => name.includes(blocker))) {
                        found.push({ name: parts[0].replace(/"/g, ''), pid });
                    }
                }
            }
            this._pendingPortLock = { port, processes: found };
            this.wsService.socketIO.emit('port-locked', {
                port,
                processes: found,
                message: found.length > 0
                    ? `${found.map(process => process.name).join(', ')} is using ${port}.`
                    : `${port} is still busy and not ready for setup yet.`,
            });
        });
    }

    async forceCloseAndFlash(data) {
        const port = data?.port || this._pendingFlashData?.deviceName || this._pendingPortLock?.port || '';
        if (port) {
            this.flashingPorts.add(port);
        }
        this.wsService.socketIO.emit('flash-progress', { step: 'closing', port });

        const board = this.boardsList.find(entry => entry.port === port);
        if (board?.io?.transport) {
            try {
                await new Promise((resolve, reject) => {
                    board.io.transport.close((err) => err ? reject(err) : resolve());
                });
            } catch (_) {}
        }
        this.boardsList = this.boardsList.filter(entry => entry.port !== port);
        cleanupInstances();

        const approvedPortLock = this._pendingPortLock?.port === port
            ? this._pendingPortLock
            : null;
        const pids = (approvedPortLock?.processes || [])
            .map(process => this._sanitizePid(process.pid))
            .filter(Boolean);

        this._pendingPortLock = null;

        if (pids.length > 0) {
            for (const pid of pids) {
                try {
                    await new Promise((resolve) => {
                        execFile('taskkill', ['/PID', pid, '/F'], () => resolve());
                    });
                } catch (_) {}
            }
        }
        await new Promise(resolve => setTimeout(resolve, pids.length > 0 ? 2000 : 1500));

        const flashData = this._pendingFlashData || { deviceName: port };
        this._pendingFlashData = null;
        await this.firmata(flashData);
    }
}

module.exports = { DeviceManager };
