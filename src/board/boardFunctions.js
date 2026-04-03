const {
    Board, Led, Servo, Motor, Button, Sensor,
    Thermometer, Proximity, Piezo, Relay,
    Switch: J5Switch, Joystick, IMU, Accelerometer,
    Gyro, Compass, Motion, ESC,
    Barometer, Hygrometer,
} = require('johnny-five');

// Maximum time (ms) to wait for a sensor reading before timing out
const SENSOR_TIMEOUT_MS = 30000;

// Track all active hardware instances for cleanup between plays
const activeInstances = new Set();
const reusableInstances = new Map();

function trackInstance(instance) {
    activeInstances.add(instance);
    return instance;
}

function getReusableInstance(key, factory) {
    if (reusableInstances.has(key)) {
        return reusableInstances.get(key);
    }

    const instance = trackInstance(factory());
    reusableInstances.set(key, instance);
    return instance;
}

function getInstanceScope(j5Board) {
    return j5Board?.port || j5Board?.id || 'default-board';
}

function normalizeEnumValue(value) {
    if (typeof value !== 'string') return '';
    return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function normalizeLedSwitchValue(value) {
    const normalized = normalizeEnumValue(value);
    if (['off', '0', 'false', 'low'].includes(normalized)) return 'off';
    if (['on', '1', 'true', 'high'].includes(normalized)) return 'on';
    return normalized || 'off';
}

function normalizeLedModeValue(value) {
    const normalized = normalizeEnumValue(value);

    switch (normalized) {
        case '':
            return 'static';
        case 'flash':
            return 'blink';
        case 'fadein':
            return 'fade-in';
        case 'fadeout':
            return 'fade-out';
        default:
            return normalized;
    }
}

function parseIntegerSetting(value, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
    const parsed = parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(parsed, max));
}

/**
 * Cleanup all active hardware instances (LEDs, servos, sensors, buttons, etc.).
 * Must be called before each new play() and before firmata re-flash.
 */
function cleanupInstances() {
    for (const instance of activeInstances) {
        try {
            if (typeof instance.stop === 'function') instance.stop();
            if (typeof instance.off === 'function') instance.off();
            if (typeof instance.removeAllListeners === 'function') instance.removeAllListeners();
        } catch (e) {
            // Instance may already be disconnected â€” safe to ignore
        }
    }
    activeInstances.clear();
    reusableInstances.clear();
}

/**
 * Force-close every possible handle a johnny-five Board might hold.
 * Tries board.io.transport (SerialPort), board.io (Firmata), and board itself.
 */
function forceCloseBoard(board) {
    try { board.removeAllListeners(); } catch (_) {}
    // Close the raw serial port (most important â€” this is what locks the COM port)
    try {
        const transport = board.io?.transport;
        if (transport) {
            transport.removeAllListeners();
            if (transport.isOpen) transport.close(() => {});
        }
    } catch (_) {}
    // Close Firmata IO layer
    try {
        if (board.io) {
            board.io.removeAllListeners();
            if (typeof board.io.close === 'function') board.io.close();
        }
    } catch (_) {}
}

/**
 * Initialize a johnny-five Board with proper Promise-based readiness.
 * Resolves only when the board is actually ready (Firmata handshake complete).
 * Rejects on error or 10s timeout.
 */
function getBoard(boardPath, wsService) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const board = new Board({ port: boardPath, repl: false });

        const cleanup = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            forceCloseBoard(board);
            reject(error);
        };

        const timer = setTimeout(() => {
            cleanup(new Error(`Board at ${boardPath} timed out after 10s`));
        }, 10000);

        board.on('ready', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            board.isReady = true;
            console.log('Arduino board ready at', boardPath);
            resolve(board);
        });

        board.on('error', (error) => {
            console.error('Error initializing board at', boardPath, ':', error.message);
            cleanup(error);
        });
    });
}

/**
 * Process a single component and chain to next.
 * Supports AbortSignal for cancellation.
 * @param {object} component - Component data (from frontend sequence)
 * @param {object} client - Socket.IO server instance for sending messages
 * @param {AbortSignal} signal - Cancellation signal
 * @param {object} [j5Board] - johnny-five Board instance (passed to hardware constructors)
 */
async function processComponent(component, client, signal, j5Board) {
    if (!component) return;
    if (signal?.aborted) return;

    // Resolve component type name â€” backend may include componentItem (populated)
    // or the name may be directly on the component itself.
    const componentType = component.componentItem?.name || component.name;
    if (!componentType) {
        console.warn('Component has no identifiable type:', JSON.stringify(component, null, 2).substring(0, 500));
        return;
    }

    emitPlaybackEvent(client, 'component-start', component);

    switch (componentType) {
        // â”€â”€ Output â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        case 'Led':
        case 'Standard LED':
            await runStandardLed(component, client, signal, j5Board);
            break;
        case 'RGB':
            await runRGBLed(component, client, signal, j5Board);
            break;
        case 'Servo':
            await runServo(component, client, signal, j5Board);
            break;
        case 'DC':
        case 'Motor':
            await runMotor(component, client, signal, j5Board);
            break;
        case 'Relay':
            await runRelay(component, client, signal, j5Board);
            break;
        case 'Piezo':
            await runPiezo(component, client, signal, j5Board);
            break;
        case 'ESC':
            await runESC(component, client, signal, j5Board);
            break;

        // â”€â”€ Input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        case 'Button':
            await runButtonCheck(component, client, signal, j5Board);
            break;
        case 'Switch':
            await runSwitchCheck(component, client, signal, j5Board);
            break;
        case 'Potentiometer':
        case 'Photoresistor':
            await runSensorCheck(component, client, signal, j5Board);
            break;
        case 'IR motion':
        case 'IR Motion':
            await runMotionCheck(component, client, signal, j5Board);
            break;
        case 'Proximity':
            await runProximityCheck(component, client, signal, j5Board);
            break;

        // â”€â”€ Environmental â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        case 'Thermometer':
        case 'Temperature':
            await runThermometerCheck(component, client, signal, j5Board);
            break;
        case 'Barometer':
            await runBarometerCheck(component, client, signal, j5Board);
            break;
        case 'Hygrometer':
        case 'Humidity':
            await runHygrometerCheck(component, client, signal, j5Board);
            break;

        // â”€â”€ Motion / IMU â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        case 'Accelerometer':
            await runAccelerometerCheck(component, client, signal, j5Board);
            break;
        case 'Gyro':
            await runGyroCheck(component, client, signal, j5Board);
            break;
        case 'IMU':
            await runIMUCheck(component, client, signal, j5Board);
            break;
        case 'Compass':
            await runCompassCheck(component, client, signal, j5Board);
            break;
        case 'Joystick':
            await runJoystickCheck(component, client, signal, j5Board);
            break;

        // â”€â”€ Flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        case 'Wait':
            await runWait(component, client, signal);
            break;
        case 'Message':
            runMessage(component, client);
            await chainNext(component, client, signal, j5Board);
            break;
        case 'Check':
            await chainNext(component, client, signal, j5Board);
            break;
        case 'Loop':
            await runLoop(component, client, signal, j5Board);
            break;

        default:
            console.warn(`Unknown component type: ${componentType}`);
    }
}

/** Wrap a sensor promise with a timeout so it doesn't wait indefinitely */
function withSensorTimeout(promise, label = 'Sensor') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${SENSOR_TIMEOUT_MS / 1000}s`)), SENSOR_TIMEOUT_MS)
        ),
    ]).catch(err => {
        console.warn(err.message);
    });
}

/** Chain to the next component (used by non-self-chaining components) */
async function continueFrom(component, nextComponent, client, signal, j5Board) {
    emitPlaybackEvent(client, 'component-end', component);
    if (!signal?.aborted && nextComponent) {
        await processComponent(nextComponent, client, signal, j5Board);
    }
}

async function chainNext(component, client, signal, j5Board) {
    await continueFrom(component, component.next, client, signal, j5Board);
}

/**
 * Process a single component WITHOUT chaining to the next.
 * Used inside loop body iteration where we manage sequencing ourselves.
 */
async function processComponentNoChain(component, client, signal, j5Board) {
    if (!component) return;
    if (signal?.aborted) return;

    const componentType = component.componentItem?.name || component.name;
    if (!componentType) return;

    // For most components, we call the same run* function but need to prevent chaining.
    // We create a wrapper that temporarily removes .next, processes, then restores it.
    const savedNext = component.next;
    component.next = null;
    try {
        await processComponent(component, client, signal, j5Board);
    } finally {
        component.next = savedNext;
    }
}

function getComponentSetting(settingName, settings) {
    const foundSetting = settings.find(setting => setting.setting.name === settingName);
    return foundSetting || null;
}

function getLedSwitchSetting(settings) {
    return getComponentSetting('Off/On', settings)
        || getComponentSetting('On/Off', settings);
}

function getPlaybackContext(client, component) {
    const playback = client?.playback || {};
    return {
        runId: playback.runId || null,
        boardId: component?.board || playback.boardId || null,
        sequenceId: component?.sequence || null,
        componentId: component?._id || null,
        componentType: component?.componentItem?.name || component?.name || null,
        devicePort: playback.devicePort || null,
    };
}

function emitPlaybackEvent(client, event, component, extra = {}) {
    const payload = {
        event,
        ...getPlaybackContext(client, component),
        ...extra,
    };
    if (!payload.runId) return;
    client?.emit?.('playback-event', payload);
}

// â”€â”€â”€ LED â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runStandardLed(component, client, signal, j5Board) {
    const pinSetting    = getComponentSetting('Digital pin', component.settings);
    const switchSetting = getLedSwitchSetting(component.settings);
    const brightSetting = getComponentSetting('Brightness', component.settings);
    const modeSetting   = getComponentSetting('Mode', component.settings);   // optional

    if (!pinSetting) {
        console.error('Standard LED: missing "Digital pin" setting');
        client?.emit?.('general-message', { message: 'LED error: no pin assigned. Open the component settings and select a pin.' });
        await chainNext(component, client, signal, j5Board);
        return;
    }

    const pin = parseInt(pinSetting.value, 10);
    if (isNaN(pin)) {
        console.error('Standard LED: invalid pin value:', pinSetting.value);
        client?.emit?.('general-message', { message: `LED error: invalid pin "${pinSetting.value}".` });
        await chainNext(component, client, signal, j5Board);
        return;
    }

    // Pass the board to johnny-five so it controls the correct Arduino
    const ledOpts = j5Board ? { pin, board: j5Board } : pin;
    const led = getReusableInstance(`${getInstanceScope(j5Board)}:standard-led:${pin}`, () => new Led(ledOpts));

    const switchValue = normalizeLedSwitchValue(switchSetting?.value);
    const mode = normalizeLedModeValue(modeSetting?.value);
    const brightnessPercent = parseIntegerSetting(brightSetting?.value ?? '100', 100, { min: 0, max: 100 });
    const supportsPwm = typeof j5Board?.pins?.isPwm === 'function'
        ? j5Board.pins.isPwm(pin)
        : false;
    const intervalMs = parseIntegerSetting(getComponentSetting('Interval', component.settings)?.value ?? '500', 500, { min: 10, max: 60000 });
    const durationMs = parseIntegerSetting(getComponentSetting('Duration', component.settings)?.value ?? '1000', 1000, { min: 10, max: 60000 });

    // Always stop any previous animation/state on this pin before applying the new command.
    led.stop();

    if (switchValue === 'off' || brightnessPercent === 0) {
        led.off();
    } else {
        switch (mode) {
            case 'blink': {
                led.blink(intervalMs);
                break;
            }
            case 'strobe': {
                led.strobe(intervalMs);
                break;
            }
            case 'pulse': {
                if (supportsPwm) {
                    led.pulse(durationMs);
                } else {
                    console.warn(`Pulse requested on non-PWM pin ${pin}; falling back to blink.`);
                    led.blink(durationMs);
                }
                break;
            }
            case 'fade-in': {
                if (supportsPwm) {
                    led.fadeIn(durationMs);
                } else {
                    console.warn(`Fade-in requested on non-PWM pin ${pin}; falling back to on().`);
                    led.on();
                }
                break;
            }
            case 'fade-out': {
                if (supportsPwm) {
                    led.fadeOut(durationMs);
                } else {
                    console.warn(`Fade-out requested on non-PWM pin ${pin}; falling back to off().`);
                    led.off();
                }
                break;
            }
            default: {
                if (supportsPwm && brightnessPercent < 100) {
                    const brightness = Math.round((brightnessPercent / 100) * 255);
                    led.brightness(brightness);
                } else {
                    led.on();
                }
            }
        }
    }

    await chainNext(component, client, signal, j5Board);
}

async function runRGBLed(component, client, signal, j5Board) {
    const redPin   = getComponentSetting('Red pin', component.settings);
    const greenPin = getComponentSetting('Green pin', component.settings);
    const bluePin  = getComponentSetting('Blue pin', component.settings);
    const switchSetting = getLedSwitchSetting(component.settings);
    const color    = getComponentSetting('Color', component.settings);

    if (!redPin || !greenPin || !bluePin) {
        console.error('RGB LED: missing pin settings');
        client?.emit?.('general-message', { message: 'RGB LED error: pin settings missing. Open the component settings.' });
        await chainNext(component, client, signal, j5Board);
        return;
    }

    const red = parseInt(redPin.value, 10);
    const green = parseInt(greenPin.value, 10);
    const blue = parseInt(bluePin.value, 10);
    const rgbOpts = {
        pins: {
            red,
            green,
            blue,
        },
    };
    if (j5Board) rgbOpts.board = j5Board;
    const led = getReusableInstance(
        `${getInstanceScope(j5Board)}:rgb-led:${red}:${green}:${blue}`,
        () => new Led.RGB(rgbOpts)
    );

    led.stop?.();

    const switchValue = normalizeLedSwitchValue(switchSetting?.value);
    if (switchValue === 'off') {
        led.off();
    } else {
        led.color(color?.value ?? '#ffffff');
        if (typeof led.on === 'function') {
            led.on();
        }
    }

    await chainNext(component, client, signal, j5Board);
}

// â”€â”€â”€ SERVO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runServo(component, client, signal, j5Board) {
    const pinSetting      = getComponentSetting('Digital pin', component.settings);
    const angleSetting    = getComponentSetting('Angle', component.settings);
    const durationSetting = getComponentSetting('Duration', component.settings);
    const modeSetting     = getComponentSetting('Mode', component.settings); // optional

    if (!pinSetting) {
        console.error('Servo: missing "Digital pin" setting');
        client?.emit?.('general-message', { message: 'Servo error: no pin assigned.' });
        await chainNext(component, client, signal, j5Board);
        return;
    }

    const servoOpts = {
        pin:     parseInt(pinSetting.value, 10),
        startAt: parseInt(angleSetting?.value ?? '90', 10),
    };
    if (j5Board) servoOpts.board = j5Board;
    const servo = trackInstance(new Servo(servoOpts));

    const mode = modeSetting?.value ?? 'to';

    switch (mode) {
        case 'sweep':
            servo.sweep();
            break;
        case 'cw':
            servo.cw();
            break;
        case 'ccw':
            servo.ccw();
            break;
        default:
            servo.to(parseInt(angleSetting?.value ?? '90', 10));
    }

    return new Promise(resolve => {
        const duration = parseInt(durationSetting?.value ?? '500', 10);
        const timer = setTimeout(async () => {
            if (!signal?.aborted) {
                await continueFrom(component, component.next, client, signal, j5Board);
            }
            resolve();
        }, duration);

        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                servo.stop();
                resolve();
            }, { once: true });
        }
    });
}

// â”€â”€â”€ MOTOR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runMotor(component, client, signal, j5Board) {
    const pinSetting     = getComponentSetting('Digital pin', component.settings);
    const speedSetting   = getComponentSetting('Speed', component.settings);
    const onOffSetting   = getComponentSetting('On/Off', component.settings);
    const dirPinSetting  = getComponentSetting('Direction pin', component.settings);  // optional
    const dirSetting     = getComponentSetting('Direction', component.settings);       // optional: forward/reverse

    if (!pinSetting) {
        console.error('Motor: missing "Digital pin" setting');
        client?.emit?.('general-message', { message: 'Motor error: no pin assigned.' });
        await chainNext(component, client, signal, j5Board);
        return;
    }

    const config = { pin: parseInt(pinSetting.value, 10) };
    if (dirPinSetting) {
        config.dir = parseInt(dirPinSetting.value, 10);
    }
    if (j5Board) config.board = j5Board;

    const motor = trackInstance(new Motor(config));

    if (onOffSetting?.value === 'off') {
        motor.stop();
    } else {
        const speed = Math.round((parseInt(speedSetting?.value ?? '100', 10) / 100) * 255);
        const direction = dirSetting?.value ?? 'forward';
        if (direction === 'reverse' && typeof motor.reverse === 'function') {
            motor.reverse(speed);
        } else {
            motor.start(speed);
        }
        if (signal) {
            signal.addEventListener('abort', () => { try { motor.stop(); } catch (_) {} }, { once: true });
        }
    }

    await chainNext(component, client, signal, j5Board);
}

// â”€â”€â”€ RELAY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runRelay(component, client, signal, j5Board) {
    const pinSetting    = getComponentSetting('Digital pin', component.settings);
    const stateSetting  = getComponentSetting('State', component.settings);
    const typeSetting   = getComponentSetting('Type', component.settings); // 'NO' | 'NC'

    if (!pinSetting) {
        console.error('Relay: missing "Digital pin" setting');
        client?.emit?.('general-message', { message: 'Relay error: no pin assigned.' });
        await chainNext(component, client, signal, j5Board);
        return;
    }

    const relayOpts = {
        pin:  parseInt(pinSetting.value, 10),
        type: typeSetting?.value === 'NC' ? 'NC' : 'NO',
    };
    if (j5Board) relayOpts.board = j5Board;
    const relay = trackInstance(new Relay(relayOpts));

    if (stateSetting?.value === 'on' || stateSetting?.value === 'open') {
        relay.open();
    } else {
        relay.close();
    }

    if (signal) {
        signal.addEventListener('abort', () => { try { relay.close(); } catch (_) {} }, { once: true });
    }

    await chainNext(component, client, signal, j5Board);
}

// â”€â”€â”€ PIEZO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runPiezo(component, client, signal, j5Board) {
    const pinSetting      = getComponentSetting('Digital pin', component.settings);
    const modeSetting     = getComponentSetting('Mode', component.settings);    // tone | song | noise
    const freqSetting     = getComponentSetting('Frequency', component.settings);
    const durationSetting = getComponentSetting('Duration', component.settings);
    const songSetting     = getComponentSetting('Song', component.settings);    // optional

    if (!pinSetting) {
        console.error('Piezo: missing "Digital pin" setting');
        client?.emit?.('general-message', { message: 'Piezo error: no pin assigned.' });
        await chainNext(component, client, signal, j5Board);
        return;
    }

    const piezoOpts = j5Board ? { pin: parseInt(pinSetting.value, 10), board: j5Board } : parseInt(pinSetting.value, 10);
    const piezo = trackInstance(new Piezo(piezoOpts));

    const mode = modeSetting?.value ?? 'tone';

    await new Promise(resolve => {
        if (mode === 'song' && songSetting?.value) {
            try {
                const song = JSON.parse(songSetting.value);
                piezo.play({ song, tempo: 150 }, () => resolve());
            } catch (e) {
                resolve();
            }
        } else if (mode === 'noise') {
            // Simulate noise with rapid random tones
            const dur = parseInt(durationSetting?.value ?? '500', 10);
            const noiseInterval = setInterval(() => {
                try { piezo.tone(Math.floor(Math.random() * 800) + 100, 50); } catch (_) {}
            }, 60);
            const noiseTimer = setTimeout(() => {
                clearInterval(noiseInterval);
                try { piezo.noTone(); } catch (_) {}
                resolve();
            }, dur);

            if (signal) {
                signal.addEventListener('abort', () => {
                    clearInterval(noiseInterval);
                    clearTimeout(noiseTimer);
                    try { piezo.noTone(); } catch (_) {}
                    resolve();
                }, { once: true });
            }
            // Early return so we don't fall through to the generic abort handler below
            return;
        } else {
            const freq = parseInt(freqSetting?.value ?? '440', 10);
            const dur  = parseInt(durationSetting?.value ?? '500', 10);
            piezo.frequency(freq, dur);
            setTimeout(resolve, dur + 100);
        }

        if (signal) {
            signal.addEventListener('abort', () => {
                try { piezo.noTone(); } catch (_) {}
                resolve();
            }, { once: true });
        }
    });

    await chainNext(component, client, signal, j5Board);
}

// â”€â”€â”€ ESC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runESC(component, client, signal, j5Board) {
    const pinSetting   = getComponentSetting('Digital pin', component.settings);
    const speedSetting = getComponentSetting('Speed', component.settings);
    const onOffSetting = getComponentSetting('On/Off', component.settings);

    if (!pinSetting) {
        console.error('ESC: missing "Digital pin" setting');
        client?.emit?.('general-message', { message: 'ESC error: no pin assigned.' });
        await chainNext(component, client, signal, j5Board);
        return;
    }

    const escOpts = j5Board ? { pin: parseInt(pinSetting.value, 10), board: j5Board } : parseInt(pinSetting.value, 10);
    const esc = trackInstance(new ESC(escOpts));

    if (signal?.aborted) return;

    if (onOffSetting?.value === 'off') {
        esc.brake();
    } else {
        const speed = Math.round((parseInt(speedSetting?.value ?? '50', 10) / 100) * 255);
        esc.throttle(speed);
    }

    await chainNext(component, client, signal, j5Board);
}

// â”€â”€â”€ BUTTON â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runButtonCheck(component, client, signal, j5Board) {
    return withSensorTimeout(new Promise((resolve) => {
        const pinSetting   = getComponentSetting('Digital pin', component.settings);
        if (!pinSetting) { console.error('Button: missing pin setting'); resolve(); return; }
        const btnOpts = j5Board ? { pin: parseInt(pinSetting.value, 10), board: j5Board } : parseInt(pinSetting.value, 10);
        const button       = trackInstance(new Button(btnOpts));
        const checkComponent = component.next;

        if (!checkComponent) { emitPlaybackEvent(client, 'component-end', component); resolve(); return; }

        const ifSetting     = getComponentSetting('If', checkComponent.settings)?.value;
        const toSetting     = getComponentSetting('To', checkComponent.settings)?.value;
        const chooseSetting = getComponentSetting('Choose', checkComponent.settings)?.value;

        if (!ifSetting || !toSetting) { resolve(); return; }

        const cleanup = () => button.removeAllListeners();

        if (signal) {
            signal.addEventListener('abort', () => { cleanup(); resolve(); }, { once: true });
        }

        if (toSetting === '0/1' && chooseSetting === 'on') {
            button.once('press', async () => {
                cleanup();
                await continueFrom(component, checkComponent.next, client, signal, j5Board);
                resolve();
            });
        } else if (toSetting === '0/1' && chooseSetting === 'off') {
            button.once('release', async () => {
                cleanup();
                await continueFrom(component, checkComponent.next, client, signal, j5Board);
                resolve();
            });
        } else if (toSetting === 'cpt') {
            const cptOpts = j5Board ? { pin: parseInt(chooseSetting, 10), board: j5Board } : parseInt(chooseSetting, 10);
            const cptButton = trackInstance(new Button(cptOpts));
            cptButton.once('press', async () => {
                cleanup();
                cptButton.removeAllListeners();
                await continueFrom(component, checkComponent.next, client, signal, j5Board);
                resolve();
            });
        } else {
            resolve();
        }
    }), 'Button');
}

// â”€â”€â”€ SWITCH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runSwitchCheck(component, client, signal, j5Board) {
    return withSensorTimeout(new Promise((resolve) => {
        const pinSetting = getComponentSetting('Digital pin', component.settings);
        if (!pinSetting) { console.error('Switch: missing pin setting'); resolve(); return; }
        const swOpts = j5Board ? { pin: parseInt(pinSetting.value, 10), board: j5Board } : parseInt(pinSetting.value, 10);
        const sw         = trackInstance(new J5Switch(swOpts));
        const checkComponent = component.next;

        if (!checkComponent) { emitPlaybackEvent(client, 'component-end', component); resolve(); return; }

        const chooseSetting = getComponentSetting('Choose', checkComponent.settings)?.value;

        if (signal) {
            signal.addEventListener('abort', () => { sw.removeAllListeners(); resolve(); }, { once: true });
        }

        const eventName = chooseSetting === 'off' ? 'open' : 'close';
        sw.once(eventName, async () => {
            sw.removeAllListeners();
            await continueFrom(component, checkComponent.next, client, signal, j5Board);
            resolve();
        });
    }), 'Switch');
}

// â”€â”€â”€ ANALOG SENSOR (Potentiometer / Photoresistor) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runSensorCheck(component, client, signal, j5Board) {
    return withSensorTimeout(new Promise((resolve) => {
        const checkComponent = component.next;
        const checkName = checkComponent?.componentItem?.name || checkComponent?.name || '';
        if (!checkComponent || checkName !== 'Check') {
            resolve();
            return;
        }

        const pinSetting    = getComponentSetting('Analog pin', component.settings);
        const ifSetting     = getComponentSetting('If', checkComponent.settings);
        const chooseSetting = getComponentSetting('Choose', checkComponent.settings);
        const toSetting     = getComponentSetting('To', checkComponent.settings);

        if (!pinSetting) { console.error('Sensor: missing "Analog pin" setting'); resolve(); return; }

        const sensorOpts = { pin: 'A' + parseInt(pinSetting.value, 10), freq: 250 };
        if (j5Board) sensorOpts.board = j5Board;
        const sensor = trackInstance(new Sensor(sensorOpts));

        // Create cptSensor once (outside onData) to avoid creating a new instance per data event
        const cptSensorOpts = { pin: 'A' + parseInt(chooseSetting?.value ?? '0', 10), freq: 250 };
        if (j5Board) cptSensorOpts.board = j5Board;
        const cptSensor = toSetting?.value === 'cpt'
            ? trackInstance(new Sensor(cptSensorOpts))
            : null;

        if (signal) {
            signal.addEventListener('abort', () => {
                sensor.removeAllListeners();
                if (cptSensor) cptSensor.removeAllListeners();
                resolve();
            }, { once: true });
        }

        const onData = async () => {
            if (signal?.aborted) { sensor.removeListener('data', onData); resolve(); return; }

            if (toSetting?.value !== 'cpt') {
                if (validateCheck(checkComponent, sensor.value)) {
                    sensor.removeListener('data', onData);
                    await continueFrom(component, checkComponent.next, client, signal, j5Board);
                    resolve();
                }
            } else if (cptSensor) {
                const passed =
                    (ifSetting?.value === '>' && sensor.value > cptSensor.value) ||
                    (ifSetting?.value === '<' && sensor.value < cptSensor.value) ||
                    (ifSetting?.value === '=' && sensor.value == cptSensor.value);
                if (passed) {
                    sensor.removeListener('data', onData);
                    cptSensor.removeAllListeners();
                    await continueFrom(component, checkComponent.next, client, signal, j5Board);
                    resolve();
                }
            }
        };

        sensor.on('data', onData);
    }), 'Sensor');
}

// â”€â”€â”€ IR MOTION (PIR HC-SR501) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runMotionCheck(component, client, signal, j5Board) {
    return withSensorTimeout(new Promise((resolve) => {
        const checkComponent = component.next;

        // PIR outputs digital HIGH/LOW â€” use Digital pin if provided, fallback to Analog pin
        const digitalPinSetting = getComponentSetting('Digital pin', component.settings);
        const analogPinSetting  = getComponentSetting('Analog pin', component.settings);
        const pin = digitalPinSetting
            ? parseInt(digitalPinSetting.value, 10)
            : 'A' + parseInt(analogPinSetting?.value ?? '0', 10);

        const motionOpts = j5Board ? { pin, board: j5Board } : pin;
        const motion = trackInstance(new Motion(motionOpts));

        if (signal) {
            signal.addEventListener('abort', () => { motion.removeAllListeners(); resolve(); }, { once: true });
        }

        motion.once('motionstart', async () => {
            motion.removeAllListeners();
            if (checkComponent) {
                await continueFrom(component, checkComponent.next, client, signal, j5Board);
            }
            resolve();
        });
    }), 'Motion');
}

// â”€â”€â”€ PROXIMITY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runProximityCheck(component, client, signal, j5Board) {
    return withSensorTimeout(new Promise((resolve) => {
        const checkComponent = component.next;
        const pinSetting     = getComponentSetting('Analog pin', component.settings)
                            || getComponentSetting('Digital pin', component.settings);
        const controllerSetting = getComponentSetting('Controller', component.settings);

        const config = {
            pin:        parseInt(pinSetting?.value ?? '0', 10),
            controller: controllerSetting?.value ?? 'GP2Y0A21YK',
            freq:       250,
        };
        if (j5Board) config.board = j5Board;

        let proximity;
        try {
            proximity = trackInstance(new Proximity(config));
        } catch (e) {
            console.error('Proximity init error:', e.message);
            resolve();
            return;
        }

        if (signal) {
            signal.addEventListener('abort', () => { proximity.removeAllListeners(); resolve(); }, { once: true });
        }

        const ifSetting     = getComponentSetting('If', checkComponent?.settings ?? []);
        const chooseSetting = getComponentSetting('Choose', checkComponent?.settings ?? []);

        proximity.on('data', async () => {
            if (signal?.aborted) { proximity.removeAllListeners(); resolve(); return; }

            const threshold = parseFloat(chooseSetting?.value ?? '20');
            const op = ifSetting?.value ?? '<';
            const triggered =
                (op === '<' && proximity.cm < threshold) ||
                (op === '>' && proximity.cm > threshold) ||
                (op === '=' && Math.abs(proximity.cm - threshold) < 1);

            if (triggered) {
                proximity.removeAllListeners();
                if (checkComponent?.next) {
                    await continueFrom(component, checkComponent.next, client, signal, j5Board);
                }
                resolve();
            }
        });
    }), 'Proximity');
}

// â”€â”€â”€ THERMOMETER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runThermometerCheck(component, client, signal, j5Board) {
    return withSensorTimeout(new Promise((resolve) => {
        const checkComponent    = component.next;
        const pinSetting        = getComponentSetting('Analog pin', component.settings)
                               || getComponentSetting('Digital pin', component.settings);
        const controllerSetting = getComponentSetting('Controller', component.settings);

        const thermoOpts = {
            pin:        parseInt(pinSetting?.value ?? '0', 10),
            controller: controllerSetting?.value ?? 'LM35',
            freq:       500,
        };
        if (j5Board) thermoOpts.board = j5Board;

        let thermo;
        try {
            thermo = trackInstance(new Thermometer(thermoOpts));
        } catch (e) {
            console.error('Thermometer init error:', e.message);
            resolve();
            return;
        }

        if (signal) {
            signal.addEventListener('abort', () => { thermo.removeAllListeners(); resolve(); }, { once: true });
        }

        const ifSetting     = getComponentSetting('If', checkComponent?.settings ?? []);
        const chooseSetting = getComponentSetting('Choose', checkComponent?.settings ?? []);

        thermo.on('data', async () => {
            if (signal?.aborted) { thermo.removeAllListeners(); resolve(); return; }

            const threshold = parseFloat(chooseSetting?.value ?? '25');
            const op = ifSetting?.value ?? '>';
            const triggered =
                (op === '>' && thermo.celsius > threshold) ||
                (op === '<' && thermo.celsius < threshold) ||
                (op === '=' && Math.abs(thermo.celsius - threshold) < 1);

            if (triggered) {
                thermo.removeAllListeners();
                // Emit temperature reading to client
                client.emit('sensor-data', { type: 'temperature', celsius: thermo.celsius, fahrenheit: thermo.fahrenheit });
                if (checkComponent?.next) {
                    await continueFrom(component, checkComponent.next, client, signal, j5Board);
                }
                resolve();
            }
        });
    }), 'Thermometer');
}

// â”€â”€â”€ BAROMETER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runBarometerCheck(component, client, signal, j5Board) {
    return withSensorTimeout(new Promise((resolve) => {
        const checkComponent    = component.next;
        const controllerSetting = getComponentSetting('Controller', component.settings);

        const baroOpts = {
            controller: controllerSetting?.value ?? 'BMP180',
            freq:       500,
        };
        if (j5Board) baroOpts.board = j5Board;

        let baro;
        try {
            baro = trackInstance(new Barometer(baroOpts));
        } catch (e) {
            console.error('Barometer init error:', e.message);
            resolve();
            return;
        }

        if (signal) {
            signal.addEventListener('abort', () => { baro.removeAllListeners(); resolve(); }, { once: true });
        }

        baro.once('data', async () => {
            client.emit('sensor-data', { type: 'barometer', pressure: baro.pressure, altitude: baro.altitude });
            if (checkComponent?.next) {
                await continueFrom(component, checkComponent.next, client, signal, j5Board);
            }
            resolve();
        });
    }), 'Barometer');
}

// â”€â”€â”€ HYGROMETER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runHygrometerCheck(component, client, signal, j5Board) {
    return withSensorTimeout(new Promise((resolve) => {
        const checkComponent    = component.next;
        const pinSetting        = getComponentSetting('Digital pin', component.settings);
        const controllerSetting = getComponentSetting('Controller', component.settings);

        const hygroOpts = {
            pin:        parseInt(pinSetting?.value ?? '2', 10),
            controller: controllerSetting?.value ?? 'DHT11',
            freq:       2000,
        };
        if (j5Board) hygroOpts.board = j5Board;

        let hygro;
        try {
            hygro = trackInstance(new Hygrometer(hygroOpts));
        } catch (e) {
            console.error('Hygrometer init error:', e.message);
            resolve();
            return;
        }

        if (signal) {
            signal.addEventListener('abort', () => { hygro.removeAllListeners(); resolve(); }, { once: true });
        }

        const ifSetting     = getComponentSetting('If', checkComponent?.settings ?? []);
        const chooseSetting = getComponentSetting('Choose', checkComponent?.settings ?? []);

        hygro.on('data', async () => {
            if (signal?.aborted) { hygro.removeAllListeners(); resolve(); return; }

            const threshold = parseFloat(chooseSetting?.value ?? '50');
            const op = ifSetting?.value ?? '>';
            const triggered =
                (op === '>' && hygro.relativeHumidity > threshold) ||
                (op === '<' && hygro.relativeHumidity < threshold) ||
                (op === '=' && Math.abs(hygro.relativeHumidity - threshold) < 2);

            if (triggered) {
                hygro.removeAllListeners();
                client.emit('sensor-data', { type: 'humidity', relativeHumidity: hygro.relativeHumidity });
                if (checkComponent?.next) {
                    await continueFrom(component, checkComponent.next, client, signal, j5Board);
                }
                resolve();
            }
        });
    }), 'Hygrometer');
}

// â”€â”€â”€ ACCELEROMETER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runAccelerometerCheck(component, client, signal, j5Board) {
    return withSensorTimeout(new Promise((resolve) => {
        const checkComponent    = component.next;
        const controllerSetting = getComponentSetting('Controller', component.settings);
        const axisSetting       = getComponentSetting('Axis', component.settings);     // x|y|z
        const ifSetting         = getComponentSetting('If', checkComponent?.settings ?? []);
        const chooseSetting     = getComponentSetting('Choose', checkComponent?.settings ?? []);

        const accelOpts = {
            controller: controllerSetting?.value ?? 'ADXL345',
            freq:       250,
        };
        if (j5Board) accelOpts.board = j5Board;

        let accel;
        try {
            accel = trackInstance(new Accelerometer(accelOpts));
        } catch (e) {
            console.error('Accelerometer init error:', e.message);
            resolve();
            return;
        }

        if (signal) {
            signal.addEventListener('abort', () => { accel.removeAllListeners(); resolve(); }, { once: true });
        }

        accel.on('data', async () => {
            if (signal?.aborted) { accel.removeAllListeners(); resolve(); return; }

            const axis      = axisSetting?.value ?? 'z';
            const value     = accel[axis] ?? 0;
            const threshold = parseFloat(chooseSetting?.value ?? '1');
            const op        = ifSetting?.value ?? '>';
            const triggered =
                (op === '>' && value > threshold) ||
                (op === '<' && value < threshold) ||
                (op === '=' && Math.abs(value - threshold) < 0.1);

            if (triggered) {
                accel.removeAllListeners();
                client.emit('sensor-data', { type: 'accelerometer', x: accel.x, y: accel.y, z: accel.z });
                if (checkComponent?.next) {
                    await continueFrom(component, checkComponent.next, client, signal, j5Board);
                }
                resolve();
            }
        });
    }), 'Accelerometer');
}

// â”€â”€â”€ GYRO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runGyroCheck(component, client, signal, j5Board) {
    return withSensorTimeout(new Promise((resolve) => {
        const checkComponent    = component.next;
        const controllerSetting = getComponentSetting('Controller', component.settings);

        const gyroOpts = {
            controller: controllerSetting?.value ?? 'ITG3200',
            freq:       250,
        };
        if (j5Board) gyroOpts.board = j5Board;

        let gyro;
        try {
            gyro = trackInstance(new Gyro(gyroOpts));
        } catch (e) {
            console.error('Gyro init error:', e.message);
            resolve();
            return;
        }

        if (signal) {
            signal.addEventListener('abort', () => { gyro.removeAllListeners(); resolve(); }, { once: true });
        }

        gyro.once('data', async () => {
            client.emit('sensor-data', { type: 'gyro', x: gyro.x, y: gyro.y, z: gyro.z, rate: gyro.rate });
            if (checkComponent?.next) {
                await continueFrom(component, checkComponent.next, client, signal, j5Board);
            }
            resolve();
        });
    }), 'Gyro');
}

// â”€â”€â”€ IMU â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runIMUCheck(component, client, signal, j5Board) {
    return withSensorTimeout(new Promise((resolve) => {
        const checkComponent    = component.next;
        const controllerSetting = getComponentSetting('Controller', component.settings);

        const imuOpts = {
            controller: controllerSetting?.value ?? 'MPU6050',
            freq:       250,
        };
        if (j5Board) imuOpts.board = j5Board;

        let imu;
        try {
            imu = trackInstance(new IMU(imuOpts));
        } catch (e) {
            console.error('IMU init error:', e.message);
            resolve();
            return;
        }

        if (signal) {
            signal.addEventListener('abort', () => { imu.removeAllListeners(); resolve(); }, { once: true });
        }

        imu.once('data', async () => {
            const acc  = imu.accelerometer;
            const gyro = imu.gyro;
            const thermo = imu.thermometer;
            client.emit('sensor-data', {
                type: 'imu',
                accelerometer: acc  ? { x: acc.x,  y: acc.y,  z: acc.z }  : null,
                gyro:          gyro ? { x: gyro.x, y: gyro.y, z: gyro.z } : null,
                celsius:       thermo?.celsius,
            });
            if (checkComponent?.next) {
                await continueFrom(component, checkComponent.next, client, signal, j5Board);
            }
            resolve();
        });
    }), 'IMU');
}

// â”€â”€â”€ COMPASS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runCompassCheck(component, client, signal, j5Board) {
    return withSensorTimeout(new Promise((resolve) => {
        const checkComponent    = component.next;
        const controllerSetting = getComponentSetting('Controller', component.settings);

        const compassOpts = {
            controller: controllerSetting?.value ?? 'HMC5883L',
            freq:       500,
        };
        if (j5Board) compassOpts.board = j5Board;

        let compass;
        try {
            compass = trackInstance(new Compass(compassOpts));
        } catch (e) {
            console.error('Compass init error:', e.message);
            resolve();
            return;
        }

        if (signal) {
            signal.addEventListener('abort', () => { compass.removeAllListeners(); resolve(); }, { once: true });
        }

        compass.once('data', async () => {
            client.emit('sensor-data', { type: 'compass', heading: compass.heading, bearing: compass.bearing });
            if (checkComponent?.next) {
                await continueFrom(component, checkComponent.next, client, signal, j5Board);
            }
            resolve();
        });
    }), 'Compass');
}

// â”€â”€â”€ JOYSTICK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runJoystickCheck(component, client, signal, j5Board) {
    return withSensorTimeout(new Promise((resolve) => {
        const checkComponent = component.next;
        const xPinSetting    = getComponentSetting('X pin', component.settings);
        const yPinSetting    = getComponentSetting('Y pin', component.settings);

        const joystickOpts = {
            pins: [
                'A' + parseInt(xPinSetting?.value ?? '0', 10),
                'A' + parseInt(yPinSetting?.value ?? '1', 10),
            ],
            freq: 100,
        };
        if (j5Board) joystickOpts.board = j5Board;

        let joystick;
        try {
            joystick = trackInstance(new Joystick(joystickOpts));
        } catch (e) {
            console.error('Joystick init error:', e.message);
            resolve();
            return;
        }

        if (signal) {
            signal.addEventListener('abort', () => { joystick.removeAllListeners(); resolve(); }, { once: true });
        }

        joystick.once('change', async () => {
            joystick.removeAllListeners();
            client.emit('sensor-data', {
                type:  'joystick',
                x:     joystick.x,
                y:     joystick.y,
                xAxis: joystick.xAxis,
                yAxis: joystick.yAxis,
            });
            if (checkComponent?.next) {
                await continueFrom(component, checkComponent.next, client, signal, j5Board);
            }
            resolve();
        });
    }), 'Joystick');
}

// â”€â”€â”€ WAIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runWait(component, client, signal, j5Board) {
    const waitSetting = getComponentSetting('Time', component.settings);
    emitPlaybackEvent(client, 'wait-start', component, {
        durationMs: parseInt(waitSetting?.value ?? '1000', 10),
    });

    return new Promise(resolve => {
        const timer = setTimeout(async () => {
            if (!signal?.aborted) {
                emitPlaybackEvent(client, 'wait-end', component);
                await continueFrom(component, component.next, client, signal, j5Board);
            }
            resolve();
        }, parseInt(waitSetting?.value ?? '1000', 10));

        if (signal) {
            signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        }
    });
}

// â”€â”€â”€ MESSAGE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function runMessage(component, client) {
    try {
        const messageSetting = getComponentSetting('Message', component.settings);
        client.emit('board-message', {
            boardId: component.board,
            message: messageSetting?.value ?? '',
        });
    } catch (e) {
        console.error('Error sending message:', e.message);
    }
}

// â”€â”€â”€ LOOP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runLoop(component, client, signal, j5Board) {
    try {
        // Detection rule: Times === '0' means Loop End, anything else means Loop Start
        const timesSetting = getComponentSetting('Times', component.settings);
        const isEnd = timesSetting?.value === '0';

        // Loop End â€” stops the chain (handled by the Loop Start that owns it)
        // When reached during normal chaining (orphan End), just continue past it.
        if (isEnd) {
            // Don't chain â€” the Loop Start caller will handle what comes after End.
            return;
        }

        // Loop Start
        const count = parseInt(timesSetting?.value ?? '1', 10);

        // Helper: determine if a Loop component is start or end
        const isLoopEnd = (comp) => {
            const ts = getComponentSetting('Times', comp.settings);
            return ts?.value === '0';
        };

        // Walk the linked list to find the matching Loop End (respecting nesting)
        let endComp = null;
        let current = component.next;
        let nestLevel = 0;

        while (current) {
            const currentName = current.componentItem?.name || current.name || '';
            if (currentName === 'Loop') {
                if (!isLoopEnd(current)) {
                    nestLevel++;
                } else {
                    if (nestLevel === 0) {
                        endComp = current;
                        break; // Found matching End
                    }
                    nestLevel--;
                }
            }
            current = current.next;
        }

        // Collect body components between Start and End into an array
        const collectBody = () => {
            const body = [];
            let node = component.next;
            while (node && node !== endComp) {
                body.push(node);
                node = node.next;
            }
            return body;
        };

        if (endComp) {
            // Loop Start/End pair found.
            // For each iteration, process components from Start.next to End (exclusive).
            // Nested loops work because processComponent â†’ runLoop recurses naturally.
            // But we can't just call processComponent(component.next) because that chains
            // through ALL components including past endComp. Instead, we process body
            // components individually, calling processComponent on each but NOT chaining.
            const bodyComponents = collectBody();

            for (let i = 0; i < count; i++) {
                if (signal?.aborted) break;
                emitPlaybackEvent(client, 'loop-iteration', component, {
                    iteration: i + 1,
                    totalIterations: count,
                });
                // Process each body component. processComponent handles nested Loop Start
                // by recursing into runLoop, which will find its own matching End and skip
                // past it. So we need to process smartly â€” walk the body and skip over
                // nested loop ranges that runLoop already handled.
                let bi = 0;
                while (bi < bodyComponents.length) {
                    if (signal?.aborted) break;
                    const bodyComp = bodyComponents[bi];
                    const bodyName = bodyComp.componentItem?.name || bodyComp.name || '';

                    if (bodyName === 'Loop' && !isLoopEnd(bodyComp)) {
                        // Nested Loop Start â€” runLoop will handle its body and return.
                        // We need to find the matching End in our body array so we can skip past it.
                        await runLoop(bodyComp, client, signal, j5Board);

                        // Skip past the nested loop's matching End
                        let nestedEnd = bi + 1;
                        let nest = 0;
                        while (nestedEnd < bodyComponents.length) {
                            const nc = bodyComponents[nestedEnd];
                            const nn = nc.componentItem?.name || nc.name || '';
                            if (nn === 'Loop') {
                                if (!isLoopEnd(nc)) nest++;
                                else {
                                    if (nest === 0) break;
                                    nest--;
                                }
                            }
                            nestedEnd++;
                        }
                        bi = nestedEnd + 1; // Skip past the nested End
                    } else if (bodyName === 'Loop' && isLoopEnd(bodyComp)) {
                        // Orphan End inside body â€” skip
                        bi++;
                    } else {
                        // Regular component â€” process without chaining (we manage iteration)
                        await processComponentNoChain(bodyComp, client, signal, j5Board);
                        bi++;
                    }
                }
            }
            // Continue after the End Loop
            if (!signal?.aborted) {
                await continueFrom(component, endComp.next, client, signal, j5Board);
            }
        } else {
            // No matching End â€” old behavior: loop runs everything after it via linked list
            for (let i = 0; i < count; i++) {
                if (signal?.aborted) break;
                await processComponent(component.next, client, signal, j5Board);
            }
            if (!signal?.aborted) {
                emitPlaybackEvent(client, 'component-end', component);
            }
        }
    } catch (e) {
        console.error('Error in loop:', e.message);
    }
}

// â”€â”€â”€ VALIDATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function validateCheck(checkComponent, value) {
    const ifSetting     = getComponentSetting('If', checkComponent.settings)?.value;
    const toSetting     = getComponentSetting('To', checkComponent.settings)?.value;
    const chooseSetting = getComponentSetting('Choose', checkComponent.settings)?.value;

    let compareValue;
    if (toSetting === 'cpt') {
        compareValue = chooseSetting;
    } else if (typeof toSetting === 'string' && toSetting.endsWith('%')) {
        compareValue = 1023 * (parseInt(chooseSetting, 10) / 100);
    } else {
        compareValue = parseFloat(chooseSetting);
    }

    switch (ifSetting) {
        case '>': return value > compareValue;
        case '<': return value < compareValue;
        case '=': return value == compareValue;
        default:  return false;
    }
}

module.exports = { processComponent, getBoard, cleanupInstances, forceCloseBoard };

