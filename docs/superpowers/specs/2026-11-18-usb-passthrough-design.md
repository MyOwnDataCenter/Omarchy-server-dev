# USB passthrough for machines and apps

Date: 2026-11-18
Status: ready for review
Repo: omarchy-server. Ship on `feat/usb-passthrough` from `upstream/main`. Open a PR against MyOwnDataCenter/server when the slices below are done. Do not add local clone-path wiring. Leave the version number and What's New to the maintainer.

## 1. Goal

The owner can see USB peripherals plugged into this Omarchy Server host (serial adapters, Zigbee/Z-Wave/Thread sticks, and similar) and bind each stick to one virtual machine or one app. Home Assistant and similar apps then see that stick. A guest may hold several sticks. A stick is bound to at most one guest.

A new **Devices** tab sits with the existing machine settings tabs, and the same tab is added on the app sheet.

## 2. Why

Machines already expose Hardware, Port forwarding, and the rest. Apps have an install-time “Use hardware devices” permission when compose already binds `/dev`, but there is no later picker. Files already treats USB disks as storage. None of that lets you plug in a Zigbee stick and attach it to Home Assistant or to a VM.

## 3. Non-goals (v1)

- USB disks as guest drives or container volumes (Files already lists external storage)
- Passing through the host keyboard and mouse
- USB hubs as bindable devices
- PCI / GPU passthrough
- Sharing one stick with two guests at once
- Auto-restarting an app or VM when a bind needs a restart
- USB/IP, iSCSI, or network-attached USB
- Members attaching or detaching sticks
- Browser E2E (Playwright `networkidle` already hangs on this SPA)

## 4. Architecture

```
Devices tab (machine sheet / app sheet)
        │ cookie session, owner for writes
        ▼
web :7780  usb.list | usb.attach | usb.detach
        │
        ▼
omarchyd :2021
  usb enumerator (sysfs + /dev/serial/by-id)
       │
       ├─ machine bind → persist on the machine record → libvirt USB hostdev
       │                 running: virsh attach-device / detach-device when QEMU allows it
       └─ app bind     → persist on the app record → compose devices: on start
                         running: do not recreate; tell the owner to restart
       │
       └─ helper usb-allow / usb-forget
            udev TAG+="uaccess" for serial nodes so rootless Podman can open them
```

Identity is stable across unplug/replug: prefer `/dev/serial/by-id/usb-…` basename; otherwise `vid:pid` plus USB serial number. Bus number and `/dev/ttyUSB0` are display-only; they are not the stored id.

## 5. Components

| Piece | Lives | Job |
|---|---|---|
| Enumerator | `omarchyd/usb.mjs` (new) | List eligible host USB, stable ids, current binding. |
| Machine bind | `omarchyd/machines.mjs` | Store `usbDevices[]` on the machine; emit libvirt `<hostdev type='usb'>`; attach/detach when running. |
| App bind | `omarchyd/apps.mjs` | Store `usbDevices[]` on the app record; inject compose `devices:` at start. |
| Helper verbs | `helper/helper.mjs` | `usb-allow ID_SERIAL` writes a udev `uaccess` rule; `usb-forget` removes it when nothing is bound to that serial. |
| Web allow-list | `server/app.mjs` | `usb.list` query; `usb.attach` / `usb.detach` mutations. |
| Machine UI | `web/src/machines/panels.tsx`, phone sheet, desktop Machines window | New panel id `usb`, label Devices, icon `usb`. |
| App UI | `web/src/AppSheet.tsx` (and the desktop app window that hosts the sheet) | Tab strip: current overview, then Devices. Same list/bind UI as machines. |
| Tests | `test/usb.test.mjs` plus existing machines/apps/helper tests | Enumerator, exclusive bind, XML, compose inject, owner-only, udev. |

Wire `createUsb` from `omarchyd/server.mjs` the same way as apps/machines. Writes go through `ownerOnly`. Members may call `usb.list`.

## 6. Data model

### Host device (from `usb.list`)

```
{
  id: string,                 // stable: by-id basename, or "vid-pid-serial"
  name: string,               // product or iManufacturer + iProduct
  vendorId: string,           // four hex chars
  productId: string,
  serial: string | null,
  path: string | null,        // /dev/serial/by-id/… when it is a serial device
  node: string | null,        // current /dev/ttyUSB* or /dev/ttyACM* (informational)
  bound: null | {kind: 'machine' | 'app', id: string, name: string}
  needsRestart: boolean       // true when this guest is running and the bind is saved but not live
}
```

### Eligibility

Include:

- USB devices that expose a serial TTY (`ttyUSB`, `ttyACM`, or `/dev/serial/by-id/usb-*`)
- Other USB peripherals that are not excluded below (webcams, vendor-class dongles)

Exclude:

- USB hubs (class `09`)
- USB mass storage (class `08`)
- HID boot keyboards and mice (class `03`, boot protocol keyboard/mouse) so the host input stays on the host

### Persistence

- Machine: `usbDevices: [{id, vendorId, productId, serial}]` on the machine record (alongside `portForwards`). `domainXml` emits one `<hostdev mode='subsystem' type='usb' managed='yes'>` per entry (vendor/product; serial when libvirt accepts it).
- App: `usbDevices: [{id, path}]` on the installed app record. On `apps.start` / compose prepare, each entry with a live `path` is added as a compose `devices:` bind (`path:path`). Missing path (unplugged) is skipped at start and shown on the tab as unplugged.

Bindings survive omarchyd restart. Unplug does not clear the bind; the tab shows the stick as unplugged until it returns with the same stable id.

## 7. RPCs

`usb.list` — query, any signed-in user. Returns `{devices: UsbDevice[]}`.

`usb.attach` — mutation, owner. Input `{deviceId, guest: {kind: 'machine' | 'app', id}}`.

- Unknown device → `NOT_FOUND`
- Already bound to this guest → no-op success
- Already bound to another guest → `CONFLICT` (“That stick is already used by {name}”)
- Guest missing → `NOT_FOUND`
- Persist, then:
  - **machine running:** try libvirt attach-device. Success → `needsRestart: false`. Failure (QEMU refused live attach) → keep persist, `needsRestart: true`, message “Restart {name} to use this stick.”
  - **machine stopped:** persist only; next start defines the domain with hostdev.
  - **app running:** persist only; `needsRestart: true`, same message. Do not recreate or restart the compose.
  - **app stopped:** persist; next start injects `devices:`.
- After a successful serial bind, helper `usb-allow` for that device’s udev serial.

`usb.detach` — mutation, owner. Input `{deviceId}`.

- Unbound → no-op success
- Persist removal, then live detach when the machine is running and QEMU allows it; apps never hot-unplug (needsRestart if still running).
- Helper `usb-forget` when no remaining bind uses that serial.

Do not add attach/detach to the in-app assistant in v1.

## 8. UI

Label: **Devices**. Icon: existing `usb`.

Machine: add `{id: 'usb', label: 'Devices', icon: 'usb'}` to `PANELS`. Render on phone `MachineSheet` and desktop `VmView` like Port forwarding.

App: the sheet today is actions only. Add a compact tab strip (`Overview` | `Devices`). Overview is the current sheet body. Devices is the shared list.

List rows:

- Name, short id (vid:pid), serial path when present
- Free: primary **Use with this {machine|app}**
- Bound here: **Remove**, and if `needsRestart` a muted note “Restart {name} to apply”
- Bound elsewhere: muted “Used by {name}”, no attach button
- Unplugged but still bound here: muted “Unplugged”, **Remove** still available

Empty: “Plug a serial adapter or Zigbee stick into this server.”

Owner sees attach/detach. Members see the list and the “Used by” labels; attach/detach controls are hidden.

## 9. Apply now vs restart

| Guest | Running | Action |
|---|---|---|
| VM | yes, QEMU accepts attach-device | Live; stick appears without reboot |
| VM | yes, QEMU refuses | Persist; tell the owner to restart the VM |
| VM | stopped | Persist; present at next start |
| App | yes | Persist; tell the owner to restart the app (rootless Podman cannot hot-plug a TTY) |
| App | stopped | Persist; present at next start |

Never restart or recreate in this feature. The owner uses the existing Start/Restart controls.

## 10. Helper and installer

New verbs, same style as `sleep` (udev file, validated serial, atomic write):

- `usb-allow SERIAL` — append `SUBSYSTEM=="tty", ENV{ID_USB_SERIAL_SHORT}=="SERIAL", TAG+="uaccess"` (and the `by-id` symlink case) to `/etc/udev/rules.d/69-omarchy-server-usb.rules`, then `udevadm control --reload` and `udevadm trigger` for that device.
- `usb-forget SERIAL` — drop that line; delete the file if empty.

SERIAL is `[A-Za-z0-9._-]{1,128}` only. No device node paths in the helper.

Bump `INSTALLER_REVISION` so existing servers copy the new helper. The in-app installer prompt already keys off that. Do not bump `package.json` version or `changelog.ts`.

## 11. Error handling

- Unplugged at attach time: `FAILED_PRECONDITION` (“Plug that stick in, then try again”)
- Helper missing/old: attach still persists; serial apps may fail to open the node until the installer runs. Surface the existing installer prompt, plus a Devices-tab note “The server helper needs an update to hand this stick to apps.”
- Libvirt attach-device error: persist, `needsRestart: true`, show the QEMU message in the toast
- Compose start with a bound stick that is unplugged: start anyway; skip that bind; tab shows Unplugged

## 12. Testing

TDD. Fake sysfs + fake serial-by-id tree; do not require real USB in CI.

- Enumerator lists a Sonoff-style serial stick; omits a hub, a USB disk, and a boot keyboard
- Stable id is the `by-id` basename; replug at a new bus keeps the same id
- Attach to Home Assistant, then attach the same id to a VM → `CONFLICT`
- One app may hold two different sticks
- Member `usb.attach` → unauthorized; `usb.list` succeeds
- Machine XML after attach contains `<hostdev type='usb'>` with the vid/pid
- Running-machine attach calls attach-device; on failure the record still has the stick and `needsRestart` is true
- App record stores the stick; `prepareCompose` / start injects `devices:`; a running app is not recreated
- Helper writes and removes the udev `uaccess` line; rejects `../../etc/passwd` as SERIAL

Host `npm test` may still fail `storage.test.mjs` `noPassword` because the installed helper has `guest ok = yes`. Mention that in the PR body. That test is unchanged.

## 13. Implementation slices

1. Enumerator + `usb.list` + tests
2. Attach/detach persistence + exclusive + owner-only
3. Libvirt hostdev + live attach/detach
4. App record + compose `devices:` + needsRestart
5. Helper udev + installer revision
6. Devices tab on machines and apps

Do not mix isolation overlay, appearance_list, or live-turn into this branch.
