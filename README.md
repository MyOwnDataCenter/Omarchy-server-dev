# Omarchy Server (development copy)

> **This is the development copy of [Omarchy Server](https://github.com/TouchWorkStation/omarchy-server).**
> New work is built and tested here first, then moved to omarchy-server when it's ready. A server
> installed from here also updates from here. For the stable version, use omarchy-server.
>
> When moving code to omarchy-server, keep omarchy-server's own repository address in `install.sh`
> (the line marked `DEV REPO`) and this README.

Turn an [Omarchy](https://omarchy.org) machine into a home server you run from any browser. Install
apps from a catalog of about 580, keep your files and drives in one place, run virtual machines, and
reach your real Omarchy desktop — from a phone, a tablet or another computer.

![Omarchy Server's desktop in a browser, with App Store, Machines and Terminal windows open](docs/screenshots/desktop-overview.jpg)

<p align="center">
  <img src="docs/screenshots/phone-home.png" width="24%" alt="Home on a phone">
  <img src="docs/screenshots/phone-store.png" width="24%" alt="App Store on a phone">
  <img src="docs/screenshots/phone-system.png" width="24%" alt="System on a phone">
  <img src="docs/screenshots/phone-machines.png" width="24%" alt="Machines on a phone">
</p>

## Install

On the Omarchy machine, as your normal user (not with sudo):

```sh
curl -fsSL https://raw.githubusercontent.com/TouchWorkStation/omarchy-server-dev/main/install.sh | bash
```

The installer:

- installs what's missing (Node.js, Podman, libvirt, wayvnc and friends);
- builds Omarchy Server in `~/.local/share/omarchy-server`;
- asks you to create your account **in the terminal**, so your password never crosses the network;
- starts two systemd user services that keep running while you're logged out.

Then open `http://<server-ip>:7780` (or `https://`, see [Security](#security)) and sign in.

Run the same command again to update, or use Settings → Software update. Your account, apps, machines
and files are kept. Logs: `journalctl --user -u omarchyd -u omarchy-server-web -f`

Want ZFS pools too? Add `--zfs` (see [Storage](#storage-and-nas)).

To remove it, run `omarchy-server uninstall`. Your account, apps and machines stay, so installing again picks up
where you left off; add `--purge` to delete those too.

## What you get

### A web app for every screen

- **Phone and tablet layout:** touch first. Home shows CPU, memory and storage at a glance, plus your
  apps. Tabs for Apps, Files, Machines and System.
- **Desktop layout** on a computer: a top bar, a dock, windows you can drag, snap and resize, desktop
  icons, an app launcher and Activities overview. Switch layouts any time.
- **Your look, everywhere:** themes, accent colours, wallpapers or your own photo, and Omarchy's own
  themes and backgrounds (the icons follow them). The desktop's wallpaper, dock and icons are saved to
  your account, so every browser you sign in on shows the same desktop.
- **The dock your way:** left, bottom, right or top; any icon size; lift or magnify under the pointer;
  bounce when an app opens; floating or auto-hide.

![Desktop & Dock settings with the desktop themes](docs/screenshots/desktop-themes.jpg)

### Apps

- **App Store:** about 580 self-hosted apps (Jellyfin, Immich, Nextcloud, Home Assistant, Vaultwarden,
  Paperless-ngx and many more), in categories, with search. Add other stores, including Umbrel-format
  ones.
- **Tailscale built in:** install it from the App Store and reach your server from anywhere on your
  tailnet. It's Omarchy's own Tailscale, set up on the server; its page sits behind your sign-in, and
  private services stay private.
- **One tap to install.** Apps that need other apps get them too. Each app opens in a window, full
  screen, or its own tab, with its default sign-in shown when it has one.
- **Safe by default:** apps run in **rootless Podman** as you — no root, no Docker socket on the
  network. Before installing, you see exactly what an app asks for (system ports, devices, host
  network, folders outside its own), and it gets only what you allow. Apps never receive your Omarchy
  Server sign-in.
- **Behind your sign-in:** every app's port admits only browsers signed in to Omarchy Server.
- Start, stop, restart, update, logs, and a shell inside any app.

![App Store in the desktop layout](docs/screenshots/desktop-app-store.png)

### Files

- Your real home folder, so the browser and the Omarchy desktop see the same files.
- Browse, upload (files and folders, drag and drop), download, rename, copy, move, search, favorites,
  recents, and the same Trash as Omarchy's file manager.
- View photos, videos, music, PDFs, documents, spreadsheets and code in the browser.
- Photo sync from your phone, and SMB network shares for any folder.

![Files in the desktop layout](docs/screenshots/desktop-files.png)

### Machines (virtual machines)

- **One tap:** Ubuntu, Debian, Fedora, Arch and Alpine (server or desktop), Omarchy, Windows 10/11 from
  your own ISO, or any ISO in Files. Images are checked against their publisher's checksums, and
  cloud-init sets up your account.
- **Proxmox-style controls** on the desktop, and every setting on a phone: CPU (sockets, cores, type),
  memory, disks, network, boot order, firmware, snapshots, backups (live), clone, restore, pause,
  hibernate, start with the server, task history, live usage graphs and a monitor.
- The screen in your browser with keyboard, mouse and touch controls, clipboard paste, and
  port forwarding to services inside a machine.
- Machines run as you under libvirt's per-user session, not as root.

![Machines in the desktop layout: the server's status, its virtual machines and backups](docs/screenshots/desktop-machines.jpg)

### Your Omarchy desktop, remotely

- The server's own Omarchy desktop, live in the browser, signed in from anywhere when it's at its
  login screen. It locks again after you finish viewing (you can turn that off).
- **Super key:** the Windows / ⌘ / Super key goes through, or Right Alt stands in for it on computers
  that keep Super to themselves. A Super button and shortcuts for the Omarchy launcher, menu and
  terminal are in the toolbar.
- Paste from your computer into the desktop's apps (Ctrl+V, or right-click → Paste on https://).
- Full screen with system keys passed through (Chrome, Edge and Brave over https://).

### Terminal

A real login shell in the browser, or a shell inside any app. Right-click copies a selection or
pastes. On a phone there's a key row with Esc, Tab, Ctrl, Alt and arrows.

![Terminal in the desktop layout](docs/screenshots/desktop-terminal.png)

### Storage and NAS

- Every drive with its health (SMART), and sleep timers for hard drives.
- **Btrfs pools** (combined, mirrored or RAID 10) on blank drives, import existing Btrfs drives, add
  drives, error checks.
- **ZFS pools** (combined, mirrored, RAID-Z1, RAID-Z2) and imports, after installing with `--zfs`.
- Pools appear in Files at `~/Pools/<name>`, and can be shared over SMB.
- Drives that hold anything are never erased: pools are only made on blank drives.

### System

- Live CPU, memory, temperature, uptime and storage, with what each app and machine is using.
- Storage pools with their space, drives, layout and errors.
- If a drive got bigger (a resized virtual disk, say), it shows the space that isn't in use yet and
  the exact commands to grow into it.
- Device name, Wi-Fi, logs, restart, shut down, factory reset, and a What's New after every update.

![System in the desktop layout](docs/screenshots/desktop-system.png)

## Local swarm (other Linux computers)

Join your other Linux computers to your server and see them in **Machines → Local swarm**:
watch them (CPU, memory, disks, temperature, updates waiting), open a terminal, see and use their
desktop, and manage them (verified Omarchy plugins, Omarchy theme, updates, restart). Linux only, on
any distribution with systemd: Omarchy, Arch, Debian, Ubuntu, Fedora, openSUSE and their relatives.

1. On your server: **Machines → Local swarm → Add a computer**. Choose what it may do (Terminal,
   Desktop, Manage; watching is always on) and tap **Make the install command**.
2. On the other computer, open a terminal as the person who uses it (not root), paste the command
   and press Enter. It asks for your password only to install Python, git and screen sharing, and
   to keep the connector running while you're signed out.
3. It appears in Local swarm within a few seconds.

How it stays safe: the connector ([connector/agent.py](connector/agent.py)) runs as that user (a
systemd user service), never as root, and dials out to your server, so the computer opens no ports.
The command carries your server's certificate fingerprint, checked before anything is sent, and a
pairing code that works once, for 15 minutes. The computer only ever allows what you chose when it
joined (the connector enforces it as well as the server), there is no "run any command": the
terminal is a shell you type into, and Manage is a short fixed list. The desktop is shared only
through a private socket in that user's runtime folder. Remove a computer and its connector forgets
your server and stops. To take the connector off a computer:

```sh
curl -fsSL https://raw.githubusercontent.com/TouchWorkStation/omarchy-server-dev/main/connector/install.sh | bash -s -- --uninstall
```

The desktop works with Hyprland, Sway and other wlroots desktops (wayvnc) and X11 desktops
(x11vnc). GNOME and KDE on Wayland can't be shared yet: sign in with an X11 session there.

## Security

- **Your password stays on the server:** it's created in the terminal, stored as a scrypt hash.
  Sign-in slows down after repeated failures, and two-factor (TOTP) codes work once each.
- **Least privilege:** the backend runs as your user and listens on `127.0.0.1` only. Root work
  (storage, firewall) goes through one small helper with a single sudoers rule, which checks every
  request itself.
- **https:// on the same port** with the server's own certificate authority. New servers' authority
  is limited to home-network names and private addresses, so it can't vouch for real websites.
  Settings → Security lets you replace an older one, send browsers to https:// always, and choose
  whether the desktop locks after remote viewing.
- **Apps are contained:** apps only get the access you approve. Their setup scripts run in a sandbox
  with no network. Their ports sit behind your sign-in.
- **No exposed screens:** the desktop and machines' screens are on private sockets, reachable only
  through a single-use ticket.
- **Signed-in devices** are listed in Settings, and you can sign any of them out.

## How it fits together

| Part | Runs as | Listens on | Does |
| --- | --- | --- | --- |
| `omarchyd` (`omarchyd/`) | you | `127.0.0.1:2021`, plus each app's port | Accounts, stats, files, apps, machines, storage. App ports admit only signed-in browsers |
| `omarchy-server-web` (`server/`, `web/`) | you | `7780` (http and https) | The web app you open in a browser |
| `helper/helper.mjs` | root, via one sudoers rule | — | Storage pools, shares, firewall ports, power |

On the server itself: `omarchy-server` (status, open, restart, logs, uninstall), "Omarchy Server" in the
launcher, and a top-bar icon (`omarchy-server widget off` removes it).

## Requirements

- An x86-64 computer running [Omarchy](https://omarchy.org) (Arch Linux + Hyprland)
- An internet connection while installing
- For machines: KVM (`/dev/kvm`) for full speed; machines still run without it, slowly
- For storage pools: extra drives (blank ones for new pools)

## Development

```sh
npm install
npm run build
npm test
```

## Credits

Omarchy is by DHH and the Omarchy contributors. This project is independent and not affiliated with
Omarchy. App icons come from [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons).
