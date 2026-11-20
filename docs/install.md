# Install OpenAFlow

OpenAFlow runs on your Windows PC, and on x64 Linux as an AppImage. It shows your pod runs across your repos. For Linux, see [Linux](#linux).

## Download

1. Open the [latest release](https://github.com/alvionlabs/openaflow/releases/latest).
2. Download `openaflow-setup-<version>.exe`.
3. Double-click the file. OpenAFlow installs for your user only. You don't need admin rights.
4. The app opens when the install ends. Later, open **OpenAFlow** from the Start menu.

## If Windows stops the installer

This build has no code signature, so Windows can warn you.

- **SmartScreen** shows "Windows protected your PC". Select **More info**, then **Run anyway**.
- **Smart App Control** can block the app, and it gives you no **Run anyway** button. If it blocks the app, tell the person who sent you this note. A code signature fixes this, and that work comes later.

## Linux

OpenAFlow runs on x64 Linux as one AppImage file. You don't need admin rights to run it.

1. Open the [latest release](https://github.com/alvionlabs/openaflow/releases/latest).
2. Download `openaflow-<version>-x86_64.AppImage`.
3. Make the file executable: `chmod +x openaflow-<version>-x86_64.AppImage`.
4. Start the file. Keep it in one folder, such as `~/Applications`, because an update replaces this file.

Install `git`, `gh`, and `claude` with your package manager or from the links under [Tools you need](#tools-you-need).

### If the AppImage doesn't start

- **FUSE 2.** An AppImage needs FUSE 2. Some systems don't install it, such as Fedora and Ubuntu 24.04. On Ubuntu and Debian, install `libfuse2` (on Ubuntu 24.04 the package is `libfuse2t64`). On Fedora, install `fuse-libs`.
- **No FUSE.** Start the file with `--appimage-extract-and-run`. The AppImage then unpacks itself into a temp folder each time, so it starts more slowly.
- **The sandbox on Ubuntu 24.04.** Ubuntu 24.04 and later limit the unprivileged user namespaces that Electron's sandbox uses. An AppImage can't carry the file permission that lets the sandbox start without them. When the AppImage's start script can't make a user namespace, it starts the app with Chromium's sandbox turned off. This note gives no change for that limit. If it matters to you, tell the person who sent you this note.

### The tray icon

The app keeps an icon in the system tray, and its menu has **Open** and **Quit**. GNOME shows no tray icons by default. To see it, install the [AppIndicator and KStatusNotifierItem Support](https://extensions.gnome.org/extension/615/appindicator-support/) extension. With no tray icon, a closed window stays hidden: start the AppImage again to show it.

### Files on Linux

- Your settings: `~/.config/openaflow-server`, or `openaflow-server` in `$XDG_CONFIG_HOME` when you set it.
- The log: `~/.config/OpenAFlow/desktop.log`.
- To remove the app, delete the AppImage file. To remove your settings too, delete `~/.config/openaflow-server`.

## Tools you need

- `git`: [Git for Windows](https://git-scm.com/downloads/win).
- `gh`: [GitHub CLI](https://cli.github.com/). Run `gh auth login` once.
- `claude`: [Claude Code](https://code.claude.com/docs/en/setup). Sign in once. If you installed it with npm, Node must be on your `Path`. A native `claude.exe` doesn't need Node.
- `pod`: [pod](https://github.com/iamphduc/claude-pod), a plugin for Claude Code. Inside Claude Code, run `/plugin marketplace add iamphduc/claude-pod`, then `/plugin install pod@pod`. With no pod, the board stays empty, because pod makes the runs it shows.

## The setup check

The app looks for `git`, `gh`, and `claude` when it starts. It doesn't look for pod. If it can't find a tool, the **Setup check** screen opens.

1. Install the tool, then select **Recheck**.
2. If the tool stays missing, type its full path in the field on that row, then select **Save**. For example: `C:\Program Files\Git\cmd\git.exe`.

A typed path also helps when your user folder name has letters outside English, such as `C:\Users\José`. The app can fail to read such a folder from your system `Path`, but a typed path still works.

## CLAUDE variables

Runs that OpenAFlow resumes keep only three `CLAUDE*` variables from your shell:

- `CLAUDE_CONFIG_DIR`
- `CLAUDE_CODE_GIT_BASH_PATH`, which must be an absolute path
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS`

OpenAFlow drops every other `CLAUDE*` variable. To use another one, put it in the `env` block of `%USERPROFILE%\.claude\settings.json`.

## Updates

The app checks for updates and downloads them for you. When an update is ready, it asks you. Select **Restart now** to install, or **Later** to wait. It asks again the next time you start the app. Your running `claude` sessions keep running through an update.

On Linux, the app updates only when you start it from the AppImage file. It doesn't update a copy that you unpacked yourself.

## Report a bug

The app keeps a small log at `%APPDATA%\OpenAFlow\desktop.log`. It holds the app's status lines and error messages, and no tokens. It writes your user folder as `~`. An error message can quote a file the app read, so read the log before you attach it to your report.

## Uninstall

Open **Settings** > **Apps** > **Installed apps**, find **OpenAFlow**, and select **Uninstall**. Your running `claude` sessions keep running.

The uninstall keeps your settings in `%APPDATA%\openaflow-server`. To remove them too, delete that folder.
