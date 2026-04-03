const Avrgirl = require('avrgirl-arduino');
const path = require('path');
const fs = require('fs');
const os = require('os');

class FirmataFlasher {
    static resolveBundledHexPath(board) {
        const hexFileName = `${board}.hex`;
        const candidatePaths = [
            path.join(__dirname, '..', 'firmware', 'hex', hexFileName),
        ];

        if (process.resourcesPath) {
            candidatePaths.push(
                path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'firmware', 'hex', hexFileName),
                path.join(process.resourcesPath, 'app.asar', 'src', 'firmware', 'hex', hexFileName),
                path.join(process.resourcesPath, 'src', 'firmware', 'hex', hexFileName),
            );
        }

        return candidatePaths.find(candidatePath => fs.existsSync(candidatePath)) || null;
    }

    /**
     * Flash StandardFirmata to an Arduino board.
     * Hex files are bundled in src/firmware/hex/. In packaged mode they're inside
     * the ASAR archive — Electron's fs can read them, but avrdude needs a real
     * filesystem path. So we copy to a temp file first.
     *
     * @param {string} portPath - Serial port path (e.g., 'COM3', '/dev/ttyUSB0')
     * @param {function} callback - Called with (error) on completion
     * @param {string} board - Board type (e.g., 'uno', 'mega', 'nano')
     */
    static flash(portPath, callback, board) {
        const SUPPORTED_BOARDS = ['uno', 'mega', 'nano', 'micro', 'leonardo'];
        const safeBoard = SUPPORTED_BOARDS.includes(board) ? board : 'uno';
        const onComplete = typeof callback === 'function' ? callback : () => {};
        const options = { board: safeBoard, debug: false };
        const bundledPath = this.resolveBundledHexPath(safeBoard);

        if (portPath) {
            options.port = portPath;
        }

        if (!bundledPath) {
            return onComplete(new Error(`Firmware file not found for ${safeBoard}. Please reinstall the bridge.`));
        }

        let hexPath;
        let tempDir;

        try {
            // Copy to temp file so avrdude can access it as a real filesystem path
            const hexData = fs.readFileSync(bundledPath);
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arduinostudio-firmata-'));
            hexPath = path.join(tempDir, `${safeBoard}.hex`);
            fs.writeFileSync(hexPath, hexData);
        } catch (e) {
            return onComplete(new Error(`Firmware file not found for ${safeBoard}. Please reinstall the bridge.`));
        }

        const avrgirl = new Avrgirl(options);

        console.log(`Flashing Firmata for ${safeBoard} on ${portPath || 'auto-detect'} (hex: ${hexPath})`);
        avrgirl.flash(hexPath, (error) => {
            // Clean up temp file
            try { fs.unlinkSync(hexPath); } catch (_) {}
            try { if (tempDir) fs.rmdirSync(tempDir); } catch (_) {}
            onComplete(error);
        });
    }
}

module.exports = { FirmataFlasher };
