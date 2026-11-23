# Launcher packages

Run `npm ci` in `launcher` before building. Both packages are written to `installer/dist`.

- On Linux, run `npm run installer:linux` with RPM build tools installed. Install the resulting RPM with `sudo dnf install ./cleanwater-launcher-linux-x86_64.rpm`.
- On Windows, run `npm run installer`. NSIS installs per user and creates **Cleanwater Launcher** shortcuts on the desktop and in the Start menu.

Run **Release launcher** in GitHub Actions on `main` after bumping the launcher version. The workflow tests the RPM before publishing it alongside the setup EXE, blockmap, and `latest.yml` needed for Windows updates.
