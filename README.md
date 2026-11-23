# Cleanwater Launcher

Cleanwater is a Windows desktop launcher for Clearwater Client on Minecraft Java Edition 26.3.

Download the x64 installer from [Releases](https://github.com/primevxie/Cleanwater/releases/latest). It installs for your Windows user and adds **Cleanwater Launcher** shortcuts to the desktop and Start menu. Open the launcher, enter an offline username, and select **Install and play**. The first launch downloads Minecraft, Java, Fabric, the required mods, and the current Clearwater JAR.

Click your username on the in-game main menu to add a premium Microsoft account through the Alt Manager. The launcher uses the game profile at `%LOCALAPPDATA%\ClearwaterLauncher\profile`.

The installed launcher checks GitHub for new launcher versions. It downloads updates in the background and applies them when you close the launcher. You can also restart from the update notice. Pressing **Play** checks for a newer Clearwater JAR and keeps the verified copy already installed if the update is temporarily unavailable or the file is busy.

## Source and build

- [launcher](launcher) contains the Electron app and download code.
- [installer](installer) contains the Windows installer configuration.

From `launcher`, run `npm ci` and then `npm start` for development. See [installer build instructions](installer/README.md) to package the app.
