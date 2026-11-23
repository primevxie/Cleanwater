# Cleanwater Launcher

Cleanwater is a desktop launcher for Clearwater Client on Minecraft Java Edition 26.3.

## Fedora and Nobara

On x86-64, open Konsole or Terminal and run the following command.

```bash
sudo dnf install 'https://github.com/primevxie/Cleanwater/releases/latest/download/cleanwater-launcher-linux-x86_64.rpm'
```

Open **Cleanwater Launcher** from the app menu or run `cleanwater-launcher`. Run the install command again to update the launcher. Remove it with `sudo dnf remove cleanwater-launcher`. The game profile lives under `$XDG_CONFIG_HOME/ClearwaterLauncher/profile`, with `~/.config` as the default.

## Windows

Download the x64 installer from [Releases](https://github.com/primevxie/Cleanwater/releases/latest). It installs for your Windows user and adds **Cleanwater Launcher** shortcuts to the desktop and Start menu. The game profile lives under `%LOCALAPPDATA%\ClearwaterLauncher\profile`. The Windows launcher downloads its own updates and applies them on exit.

## First launch

Enter an offline username and select **Install and play**. The launcher downloads Minecraft, Java, Fabric, the required mods, and Clearwater. Click your username in Clearwater’s main menu to add a Microsoft account through the in-game Alt Manager.

On both platforms, **Play** checks for a new Clearwater JAR and keeps the verified copy already installed if an update is temporarily unavailable or the file is busy.

## Source and build

- [launcher](launcher) contains the Electron app and download code.
- [installer](installer) contains the Windows and Linux packaging configuration.

From `launcher`, run `npm ci` and then `npm start` for development. See [installer build instructions](installer/README.md) to package the app.
