# Storage and Format on swarm computers

Date: 2026-11-19
Status: ready for review
Repo: omarchy-server. Ship on `feat/swarm-storage` from `upstream/main`. Open a PR against MyOwnDataCenter/server when the slices below are done. Do not add local clone-path wiring. Leave the version number and What's New to the maintainer.

## 1. Goal

The owner opens a Local swarm computer, then Storage, and sees that computer’s disks the way Settings → Storage already works on this Omarchy Server: health, sleep for hard drives, pools, and a per-drive sheet.

On that drive sheet they can **Unmount** a data disk and **Format** it. Format wipes the whole disk (never the system disk), then they pick **blank**, **ext4**, or **exFAT**. They confirm by typing the drive’s model name.

The same Format / Unmount controls land on this server’s Storage drive sheet. Today that sheet only shows `sudo wipefs -a …` and never erases; v1 replaces that with a real Format action.

## 2. Why

A swarm computer already reports mounted filesystems (`/` plus extras) for gauges. There is no per-drive screen, and the connector cannot format anything: it runs as the user, `NoNewPrivileges=yes`, with a closed manage list (plugins, theme, reboot).

People plug in a USB stick or extra disk and want to wipe it from the app, with a filesystem they choose, without SSHing in.

## 3. Non-goals (v1)

- Virtual-machine disks (libvirt qcow2). VM Hardware already has bus, cache, TRIM, grow, and remove.
- Filesystem check (fsck / btrfs scrub as a separate drive tool). Pool **Check for errors** already exists for pools and stays.
- Secure erase, ATA sanitize, badblocks, benchmarks
- Partition editor, RAID, LUKS
- Auto-unmount as part of Format
- Showing a swarm computer’s `~/Pools` in this server’s Files app or sharing them over SMB
- `files.*` / Samba / `grow-system` on swarm computers
- Assistant tools for Format / Unmount
- Members performing Format, Unmount, sleep, or pool writes
- Browser E2E
- A general “run this command” agent

## 4. Architecture

```
Settings → Storage (this server)          Swarm computer → Storage
        │                                          │
        ▼                                          ▼
web :7780  storage.*                    web :7780  swarm.storage.*
        │                                          │  (agent id, owner, storage ability)
        ▼                                          ▼
omarchyd storage.mjs                    omarchyd connector.mjs → WS call
        │                                          │
        ▼                                          ▼
host helper.mjs (root)                  swarm helper.py (root)
  smart, sleep, pools,                  smart, sleep, umount, format, pools
  NEW: umount, format
```

Gauges keep using connector `metrics.disks` (mounted filesystems, 30s). Storage does **not** ride that push. Opening Storage queries `swarm.storage.disks` / `pools` / `importable` / `status` on demand (30s while the page is open), same cadence as this server.

Identity for writes is `/dev/disk/by-id/…` resolved to a whole-disk node. `/dev/sdX` is display-only.

### Privilege

The swarm connector stays a user service. Format needs root, so the connector install (when Storage is allowed) adds:

- `/usr/local/libexec/omarchy-connector/helper.py` root-owned, locked verbs
- sudoers NOPASSWD for that helper only, for the installing user
- Drop `NoNewPrivileges=yes` on `omarchy-connector.service` **only** when Storage is in `--allow`, so `sudo -n helper` works. Without Storage, keep `NoNewPrivileges=yes`.

The agent still has no “run this command”. It may call the helper with a fixed verb + validated arguments.

Existing swarm computers must: (1) run the connector install again to get the helper, (2) pair again with Storage switched on. The server cannot widen abilities after join.

## 5. Components

| Piece | Lives | Job |
|---|---|---|
| Host Format/Unmount | `helper/helper.mjs`, `omarchyd/storage.mjs` | New verbs; refuse system/pool/mounted; bump `INSTALLER_REVISION` |
| Swarm helper | `connector/helper.py` (new) | Same safety rules; Python 3 stdlib + `wipefs` / `mkfs` / `smartctl` / `lsblk` / `umount` / btrfs (zfs if present) |
| Connector install | `connector/install.sh` | Packages, helper, sudoers, unit flag; `--allow` may include `storage` |
| Agent | `connector/agent.py` | Ability `storage`; `call` verbs for storage; **no** SMART in the 3s/30s watch snapshot |
| RPCs | `omarchyd/connector.mjs`, `omarchyd/storage.mjs`, `server/app.mjs` | Host `storage.unmount` / `storage.format`; swarm `swarm.storage.*` |
| UI | `web/src/screens/Storage.tsx`, `web/src/swarm/Swarm.tsx` | One Storage page, `target: 'host' \| {agentId}`. Agent sheet gains a Storage row |
| Pairing | swarm Add-a-computer | Checkbox **Storage** next to Terminal / Desktop / Manage |
| Tests | `test/storage.test.mjs`, `test/connector.test.mjs`, `test/swarm-storage.test.mjs` (new) | Fake helper; no real USB |

## 6. Data model

A drive (host `storage.disks` and swarm `swarm.storage.disks`) keeps the current host shape, plus:

```
{
  path: string,                 // whole-disk node, e.g. /dev/sdb
  id: string,                   // by-id path when present, else path
  name: string,
  model: string | null,
  serial: string | null,
  size: number,
  kind: 'hdd' | 'ssd' | 'nvme',
  transport: string | null,
  removable: boolean,
  role: 'system' | 'pool' | 'blank' | 'data',
  pool: string | null,
  mounted: boolean,             // any partition of this disk is mounted
  mounts: string[],             // those mountpoints
  btrfs / zfs / sleepMinutes / health  // as today
}
```

`role === 'system'` if any partition is a SYSTEM_MOUNT (`/`, `/boot`, `/efi`, `/boot/efi`, `/home`, `/var`, `/usr`, `[SWAP]`) or the disk backs those. Format, Unmount, sleep, and pool-create refuse it.

## 7. Format and Unmount

**Unmount** — owner, storage ability on swarm. Unmounts every mountpoint on that disk. Fails `PRECONDITION_FAILED` if it is the system disk or a pool member. Busy filesystems fail with the kernel message.

**Format** — owner, storage ability on swarm. Input `{device, filesystem}` where `filesystem` is `blank` | `ext4` | `exfat`. `device` is the by-id path (or `path` if no by-id).

Refuse (`PRECONDITION_FAILED`) when:

- System disk
- Pool member
- Still mounted (Unmount first; Format does not unmount)
- Unknown / not a whole disk

Then: `wipefs -a` on the whole disk. If `ext4`: `mkfs.ext4 -F`. If `exfat`: `mkfs.exfat`. If `blank`: stop after wipefs. No partition table in v1.

If `mkfs.exfat` is missing, the confirm dialog omits exFAT (or Format returns a clear error). ext4 is required; helper install pulls `e2fsprogs` when needed.

UI confirm: danger dialog, filesystem segmented control, text field that must match the drive **model** (trimmed, case-insensitive). If model is empty, match the last 4 characters of serial, else the kernel name (`sdb`). Confirm button stays disabled until it matches.

Format stays disabled on the sheet while `role` is `system` or `pool`, or `mounted` is true. Show why in muted text.

## 8. Pools, sleep, health

On swarm, with the helper present:

- Pools create / import / add / scrub / forget behave as on this server, mounted at that user’s `~/Pools/NAME` on **that** computer.
- HDD sleep uses the same udev hdparm pattern as the host helper.
- SMART is `smartctl` via the helper when listing drives. Missing smartctl → health unknown, page still works.

This server’s Files app does not grow a “swarm pools” tree. Samba stays host-only.

## 9. RPCs

Host (existing plus):

- `storage.unmount` `{device}` mutation, owner
- `storage.format` `{device, filesystem}` mutation, owner

Swarm (all take `id` of the agent):

- `swarm.storage.status` query — `{helperAvailable, zfsAvailable, storageAllowed}`
- `swarm.storage.disks` | `pools` | `importable` queries — owner (same as `swarm.list`)
- `swarm.storage.unmount` | `format` | `setSleep` | `createPool` | `addToPool` | `importPool` | `forgetPool` | `scrub` mutations — owner, require `storage` ability and helper

Missing helper → `PRECONDITION_FAILED` “Run the connector install again on {name}.”
Ability off → `FORBIDDEN` “Pair {name} again with Storage switched on.”
Offline → `PRECONDITION_FAILED` as today.

Allow-list the new names in `server/app.mjs`.

## 10. UI

**This server:** Settings → Storage drive sheet: drop the “erase it in a terminal / wipefs” card. Add Unmount (when mounted and not system/pool) and Format (when not system/pool and not mounted). Keep health, serial, role, HDD sleep.

**Swarm:** Agent sheet, after gauges, a **Storage** row. Opens the same Storage page with `target = {agentId}`.

- Helper missing: the existing “run the installer” empty state, copy aimed at the connector install command (from Add a computer).
- Storage ability off: “Pair this computer again with Storage switched on.”
- Offline: Storage row disabled.

Reuse `Storage.tsx` rather than a second copy. Host calls `storage.*`; swarm calls `swarm.storage.*` with `id`.

## 11. Helper verbs

Host `helper.mjs` (and matching swarm `helper.py`):

- `umount DEV` — unmount every partition of whole-disk DEV; refuse system/pool
- `format DEV FS` — FS is `blank` | `ext4` | `exfat`; wipefs then optional mkfs; refuse system/pool/mounted

DEV must resolve to a whole disk (`/dev/sdX`, `/dev/vdX`, `/dev/nvmeXnY`, `/dev/hdX`, or a `/dev/disk/by-id/…` symlink to one). No relative paths.

Keep the current rule that **pool-create / pool-add** only accept **blank** drives. Format to `blank` is how a data disk becomes pool-eligible. Format to ext4/exFAT makes `role: 'data'`.

Bump host `INSTALLER_REVISION` for the new host helper verbs. Do not bump `package.json` version or `changelog.ts`.

Swarm helper install is the connector script, not `INSTALLER_REVISION`.

## 12. Error handling

- Busy unmount → toast with the kernel message; disk stays mounted
- Format in progress: disable the sheet actions until the RPC returns (wipe of a large disk can take a while; helper timeout matches host helper, 10 minutes)
- Helper/sudo failure → toast; do not pretend the disk is blank
- Partial format (wipefs ok, mkfs fail) → role is blank-ish; toast the mkfs error; owner can Format again
- `NoNewPrivileges` still on an old unit → helperAvailable false, install prompt

## 13. Testing

TDD. Fake block devices / helper; do not require a real USB disk.

- Host Format refuses system disk, pool member, and mounted disk
- Host Format `blank` calls wipefs only; `ext4` then mkfs.ext4; `exfat` then mkfs.exfat
- Host Unmount unmounts every partition of that disk
- Member `storage.format` unauthorized
- Swarm: ability off → FORBIDDEN; helper missing → PRECONDITION_FAILED; offline → PRECONDITION_FAILED
- Swarm helper refuses `../../etc/passwd` as DEV
- Pairing without `storage` does not install the helper and keeps `NoNewPrivileges=yes`
- Pairing with `storage` installs helper + sudoers and drops `NoNewPrivileges`
- Gauges still use mount-usage `metrics.disks`; Storage list is a separate query
- Existing `storage.test.mjs` `noPassword` host fail (installed helper `guest ok = yes`) is unchanged; mention it in the PR body

## 14. Implementation slices

1. Host helper `umount` / `format` + Storage drive sheet Format/Unmount + tests
2. Connector ability `storage`, helper.py, install.sh, unit/sudoers, tests
3. `swarm.storage.status` / `disks` (health) + Storage row on the agent sheet (read-only)
4. Swarm Unmount / Format RPCs + confirm dialog
5. Swarm pools + HDD sleep (same UI as host)

Do not mix isolation overlay, USB passthrough, or assistant Approve-copy into this branch.
