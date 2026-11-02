# VoronMCP

A bridge between Claude and your Klipper printer, built for a Voron 2.4 with a CAN toolhead, for tuning, troubleshooting and making the printer more reliable. It runs as its own Docker container and talks to the printer through **Moonraker's own HTTP API** (the same one Mainsail and Fluidd use). It gives Claude a Model Context Protocol (MCP) endpoint. Nothing is installed on the printer. It has the same look, settings layout and security as HomeClaude and LiveCompanion.

## What Claude can do

### Look only (read everything)

- **Overview:** Klipper and Moonraker state and versions, the print and its progress, temperatures, homed axes and QGL. It also shows each MCU with its firmware version and link numbers, the CAN interfaces, the Pi's temperature and throttling, config warnings, and SAVE_CONFIG items waiting.
- **CAN and MCU link health:** this is the main reliability tool.
  - Live link numbers for each MCU: `bytes_retransmit`, `bytes_invalid`, `srtt`, `rto` and MCU load.
  - The `canbus_stats` errors and bus state.
  - The CAN interface's bitrate and **txqueuelen** (it warns under 128).
  - **Firmware mismatches** between the host and each board.
  - The retransmit trend through the current Klipper session from klippy.log, with the worst minutes and a rate per hour, explained in plain words.
- **klippy.log analysis, per Klipper session:**
  - every shutdown and error, with the lines around it: Timer too close, Lost communication, MCU shutdown, TMC errors, heater and ADC faults, homing, probe and config errors, internal errors
  - counts of each kind
  - prints started and finished
  - the link numbers over the session

  `read_log` shows the raw lines, the latest or by pattern, for klippy.log, moonraker.log, crowsnest.log and rotated logs.
- **Config:**
  - list, read (with line numbers) and search every file in the config folder
  - the settings Klipper actually loaded, with defaults filled in
  - G-code macros, with the file each one is defined in
- **Tuning data:**
  - temperatures over the last 20 minutes, with how well each heater holds its target (a PID tune due, a heater running out of power)
  - the bed mesh's range and corners
  - TMC driver currents and status flags
  - print history, with how many prints ended in a shutdown
  - the console, which shows calibration results
  - G-code metadata
  - host system and update status
- **Webcam snapshot:** Claude can look at the print or the toolhead.

### Help build

Help build includes everything in Look only, plus:

- **Change or create config files.** Changes are exact edits (each one must match once) or whole files.
  - Claude has to read a file first, and a file that changed since then is refused.
  - Every change is **backed up**, read back to check it, and goes through **keep or revert**.
- **Restart Klipper or do a firmware restart.** VoronMCP waits for Klipper to come back and reports config errors with Klipper's own message.
- **SAVE_CONFIG.** printer.cfg is backed up first, and the change is reviewed like any other.

None of this works while a print is running or paused.

### Hands on

Hands on includes everything in Help build, plus:

- **Run G-code:** moves, heaters, homing, QGL and calibrations such as SHAPER_CALIBRATE, PID_CALIBRATE, PROBE_ACCURACY and BED_MESH_CALIBRATE. Klipper's console output and errors come back to Claude.
- **Control prints:** start, pause, resume, and cancel (cancel needs an explicit confirm).
- **Emergency stop.**

Claude is told to make sure you are at the printer before it moves or heats anything.

### Full

Full includes everything in Hands on, plus deleting files (config files are backed up; printer.cfg never) and restarting services. Full only works on your network.

## Safety rules

VoronMCP checks these itself before anything reaches Moonraker, so they hold whatever Claude asks for. They are set on the Permissions page.

- **Blocked G-code** (default `FORCE_MOVE`, `SET_KINEMATIC_POSITION`, `M302`, `RUN_SHELL_COMMAND`): refused in any G-code Claude sends.
- **Commands with their own tool:** `FIRMWARE_RESTART`, `RESTART`, `SAVE_CONFIG`, `M112` and `SDCARD_PRINT_FILE` go through their own tools, which check and back up first.
- **Temperature limits** (default hotend 300 °C, bed 120 °C, anything else 80 °C): applied to `M104`/`M109`/`M140`/`M190`, `SET_HEATER_TEMPERATURE` and `PID_CALIBRATE`.
- **While a print is running or paused**, only live tuning is accepted:
  - speed and flow factor
  - pressure advance
  - velocity and acceleration limits
  - babystepping, at most 0.1 mm at a time
  - fans
  - temperatures within the limits (never 0)
  - messages, `EXCLUDE_OBJECT` and queries

  No restarts, SAVE_CONFIG or config-error-prone actions are allowed.
- **Config files:**
  - only plain config files in the config folder, with no `..` and no hidden files
  - **protected files** (default `moonraker.conf`) can be read but not changed
  - no new `[gcode_shell_command]` sections
  - the **SAVE_CONFIG block** at the end of printer.cfg is only changed when Claude says so on purpose
- **Webcam:** snapshots are only fetched from the printer's own host.

Macros already on the printer run as they are written: if a macro you wrote calls `FORCE_MOVE`, running that macro runs it. The rules check what Claude sends and saves, not what existing macros do.

## Run it

**Docker Compose:**

```
docker compose up -d
```

**TrueNAS SCALE:**

1. Go to **Apps > Discover Apps > Custom App > Install via YAML**.
2. Paste `truenas-app.yaml`.

Its data lives in a volume TrueNAS manages (`voronmcp-data`), so there is no dataset or permission to set up. The settings page is on **9087** and the public port is **9088**; change the left-hand numbers if those are taken. It uses the `latest` image with `pull_policy: always`. The GitHub workflow builds images for amd64 and arm64 (`ghcr.io/leonidis2013/voronmcp`), so it also runs on a Raspberry Pi.

**Without Docker:** run `node server.js` (Node 22+, no npm packages). `node server.js --demo` runs against a pretend Voron, with the access token `demo`.

## Set up

The first time you open VoronMCP, a **setup guide** walks you through it:

1. **Let VoronMCP into Moonraker.** Do one of these:
   - Add the IP address of the machine VoronMCP runs on to `trusted_clients` under `[authorization]` in `moonraker.conf`, then restart Moonraker.
   - Or create an API key in Mainsail or Fluidd and paste it into VoronMCP. It is stored encrypted.
2. **Enter the printer's Moonraker address** using its **IP address**, for example `http://192.168.1.50:7125` (`.local` names usually do not resolve inside a container), and press **Test**.
3. **Choose what Claude may do.** Start with Look only.
4. **Set a PIN** (optional; required in exposed mode).
5. **Connect Claude.**

### Claude Code on a computer on your network

```
claude mcp add --transport http voronmcp http://<VoronMCP machine>:9087/mcp --header "Authorization: Bearer <token>"
```

### claude.ai, Claude Desktop and the phone app: exposed mode

These apps connect from Anthropic's servers, so VoronMCP has to be reachable through a reverse proxy with https, for example a Cloudflare Tunnel or Nginx Proxy Manager. This works exactly like HomeClaude:

1. Set a PIN.
2. Point the proxy at the **public port** (9088), never at the settings port.
3. Enter the public address, switch to **Exposed**, and press **Test**.
4. On claude.ai, add a custom connector at `https://<your address>/mcp`.
5. Approve the code it shows on VoronMCP's page at home, or with your authenticator app when you are away.

Connections from outside get **Help build** at most by default. You can raise the ceiling to Hands on, but **Full never works from outside**. Every connection has its own level and access time, and can be revoked in the Security tab.

### Try it

> Use VoronMCP to check my toolhead's CAN link health.

> My last print stopped with Timer too close. Find out why.

> Review my printer.cfg for problems and suggest improvements.

> Tune my pressure advance.

## Security

Security is the same as HomeClaude:

- The settings page is on a private port, and that port refuses proxied and outside requests in exposed mode.
- The public port only serves Claude's sign-in and `/mcp`.
- Sign-in uses OAuth 2.1 with PKCE, approved at home (or with an authenticator code). Tokens are short-lived, rotate, and include theft detection.
- Abuse limits apply.
- Requests are https only, and pages have strict headers and CSP.
- The Moonraker API key and the access token are encrypted with AES-256-GCM. To keep the key off the volume, set `VORONMCP_MASTER_KEY`.
- An off switch for Claude access sits on the dashboard.
- The dashboard's **Emergency stop** button works without the PIN; stopping must always be quick.

## How it talks to Claude

Claude sends `POST /mcp` with JSON-RPC and gets plain JSON back. VoronMCP supports the stateless 2026-07-28 revision and the older `initialize` handshake. Tools appear only at the level that allows them. The webcam tool returns an image.

## Testing status

`npm test` runs 27 tests, covering:

- **The rules in VoronMCP:**
  - G-code parsing, blocked commands, the commands with their own tool, temperature limits
  - live-tuning-only while printing, the babystep limit
  - config paths, protected files, shell sections, the SAVE_CONFIG block
- **klippy.log analysis:** sessions, events with context and wall-clock times, retransmit windows and verdicts, canbus_stats.
- **Every tool against a pretend Voron:**
  - read-before-write and changed-since-read refusals
  - exact unique edits, backups, reviews
  - config errors after a restart
  - SAVE_CONFIG backed up and reviewed
  - G-code with console output
  - printing rules, cancel confirm, delete rules
- **The real Moonraker client against a fake Moonraker over HTTP:**
  - object queries, downloads, multipart uploads into folders, deletes
  - API key, 401 explained, refused connections, webcam host check
- **The whole server over HTTP:**
  - the printer connection with an encrypted key
  - keep or revert (edits, creations, deletions, repeated edits, the no-answer timer)
  - backups listed, downloaded and restored
  - levels and the outside ceiling
  - token, Origin check, off switch, PIN
  - restart buttons and the PIN-free emergency stop
- **Security tests shared with HomeClaude:** OAuth, exposed mode, authenticator codes, master key.

The page was checked in a browser in demo mode at desktop and phone sizes.

**Not tested against a real printer.** The calls follow Moonraker's documented API, and the pretend printer copies its answers. Expect a few first-run fixes on a real Voron; please report what you find.

## Versions

Versions are `major.minor.patch` in `package.json`. On every push to `main`, the GitHub workflow runs the tests, then builds and publishes the image tagged `latest` and with that version.
