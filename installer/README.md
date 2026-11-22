# Windows installer

Run `npm ci` and `npm run installer` in the `launcher` directory. The x64 setup executable is written to `installer/dist`.

The NSIS configuration installs per user, creates desktop and Start menu shortcuts named **Cleanwater Launcher**, and keeps the separate game profile when the launcher is uninstalled.
