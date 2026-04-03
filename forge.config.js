const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const path = require("path");

module.exports = {
  packagerConfig: {
    asar: true,
    // Unpack files that need real filesystem access at runtime:
    // - firmware .hex files (avrdude needs a real FS path, not ASAR)
    // - native .node modules (handled by plugin-auto-unpack-natives too)
    // - tray icon assets
    asarUnpack: ["src/firmware/**", "src/assets/**"],
    executableName: "arduinostudio",
    // Icon path without extension — Forge picks .ico (Win), .icns (mac), .png (Linux)
    icon: path.join(__dirname, "src", "assets", "favicon"),
    appBundleId: "com.arduinostudio.agent",
    appCategoryType: "public.app-category.developer-tools",
    win32metadata: {
      CompanyName: "inteRFace R&D",
      FileDescription: "ArduinoStudio Bridge Agent",
      ProductName: "ArduinoStudio",
    },
    // macOS code signing — set environment vars CS_IDENTITY / APPLE_ID when ready
    // osxSign: { identity: process.env.CS_IDENTITY },
    // osxNotarize: { appleId: process.env.APPLE_ID, appleIdPassword: process.env.APPLE_ID_PASSWORD, teamId: process.env.APPLE_TEAM_ID },
  },

  rebuildConfig: {
    force: true,
  },

  makers: [
    // Windows: Squirrel creates a proper Setup.exe installer
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "arduino_studio",
        setupExe: "ArduinoStudio-Bridge-Setup.exe",
        setupIcon: path.join(__dirname, "src", "assets", "favicon.ico"),
        iconUrl: "https://app.arduinostudio.com/favicon.ico",
        loadingGif: path.join(__dirname, "src", "assets", "install-loading.gif"),
        authors: "inteRFace R&D",
        owners: "inteRFace R&D",
        description: "ArduinoStudio Bridge",
        noMsi: true,
      },
    },

    // macOS: DMG drag-to-Applications installer
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        name: "ArduinoStudio-Bridge",
        overwrite: true,
        format: "UDZO",
        icon: path.join(__dirname, "src", "assets", "favicon.icns"),

        additionalDMGOptions: {
          window: { size: { width: 540, height: 380 } },
        },
      },
    },

    // Linux: .deb for Debian/Ubuntu
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          name: "arduino-studio-bridge",
          productName: "ArduinoStudio Bridge",
          icon: path.join(__dirname, "src", "assets", "favicon.png"),
          categories: ["Development"],
          description:
            "Local bridge agent for ArduinoStudio — controls Arduino boards in real time",
          maintainer: "inteRFace R&D <contact@arduinostudio.com>",
          homepage: "https://arduinostudio.com",
        },
      },
    },

    // Linux: .rpm for Fedora/RHEL/CentOS
    {
      name: "@electron-forge/maker-rpm",
      platforms: ["linux"],
      config: {
        options: {
          name: "arduino-studio-bridge",
          productName: "ArduinoStudio Bridge",
          icon: path.join(__dirname, "src", "assets", "favicon.png"),
          categories: ["Development"],
          description: "Local bridge agent for ArduinoStudio",
          homepage: "https://arduinostudio.com",
        },
      },
    },
  ],

  plugins: [
    // Automatically unpacks native .node modules from ASAR
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
    // Security hardening — disable dangerous Electron features in production
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
