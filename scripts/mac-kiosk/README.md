# Mac mini kiosk: relaunch the dashboard after a power cut

(Moved here from the homedash repo with the dashboard itself, unscrypted#3, with homedash#24's fix folded in.)

Turns the living-room Mac into an appliance: it logs in, waits for the dashboard, and opens it
fullscreen, and it does the same again after a power cut or a browser crash.

> Written and syntax-checked on Windows; **first run on the Mac is the real test.** Everything
> here is reversible with `./install.sh uninstall`.

## 0. The easy way: one file

`homedash-kiosk-setup.sh` bundles the launcher and the installer in a single file (it is built from
`homedash-kiosk.sh` and `install.sh`; keep them in step). Copy it to the Mac and run:

    bash homedash-kiosk-setup.sh              # install; dashboard opens fullscreen now and at every login
    bash homedash-kiosk-setup.sh settings     # also: restart after power failure, never sleep, no screen saver
    bash homedash-kiosk-setup.sh uninstall    # remove it

The sections below describe the same thing piece by piece.

## 1. Install the launcher

On the Mac, in a Terminal, from this folder:

    ./install.sh

The dashboard should open fullscreen straight away. It reopens at every login. Log:
`~/Library/Application Support/homedash-kiosk/kiosk.log`.

The launcher's settings are baked into the LaunchAgent (its `EnvironmentVariables`) when you install,
so set them on the install command:

    HOMEDASH_URL=http://10.0.1.248 ./install.sh

| Setting | Default | What it does |
|---|---|---|
| `HOMEDASH_URL` | `http://homedash.local` | The address to show. The dashboard keeps that name (and its own IP, `10.0.1.248`) after the move into unscrypted. |
| `HOMEDASH_WAIT` | `180` | Seconds to wait for the dashboard to answer before opening the browser anyway. `0` waits forever. |
| `HOMEDASH_BROWSER` | first of Chrome, Edge, Brave, Chromium | A browser binary to use instead. |

To change one later, edit it in `~/Library/LaunchAgents/com.hooptiej.homedash-kiosk.plist` and run
`launchctl kickstart -k gui/$(id -u)/com.hooptiej.homedash-kiosk`, or re-run the install with it set.

## 2. Make the Mac itself recover (once, by hand)

These are system settings; they can't be done from the script.

| Setting | Where / command |
|---|---|
| Log in automatically | System Settings > Users & Groups > "Automatically log in as" (the display user) |
| Restart after a power failure | `sudo pmset -a autorestart 1` |
| Never sleep, display always on | `sudo pmset -a sleep 0 displaysleep 0` (the launcher also holds a `caffeinate`) |
| No screen saver | `defaults -currentHost write com.apple.screensaver idleTime 0` |
| No update/notification pop-ups on the screen | Focus / Do Not Disturb, always on for this user |

> Automatic login means anyone at the machine gets the desktop. That is the intent for a
> wall display; if the Mac holds anything private, give it a dedicated standard user with
> nothing else on it.

## 3. Behaviour you should know

- **Waits for the dashboard, but not forever and not silently.** After a power cut the NAS may come up
  after the Mac, so the script waits until `<HOMEDASH_URL>/healthz` answers before opening the browser.
  Every 30 s it logs what the probe sees (with a timestamp and curl's error). After `HOMEDASH_WAIT`
  seconds (default 180) it opens the browser anyway, so a probe that can never succeed can't hold the
  display hostage (homedash#24).
- **`.local` names and launchd.** On the Mac mini, a background launchd job couldn't resolve
  `homedash.local` (curl: "Resolving timed out"), while the same probe to `http://10.0.1.248` worked
  (homedash#24). If the log shows that, install with `HOMEDASH_URL=http://10.0.1.248`. The page itself
  doesn't depend on the name.
- **Dedicated browser profile, nothing syncs back.** Kept under
  `~/Library/Application Support/homedash-kiosk/`. It is never signed in, and the launcher also passes
  `--disable-sync`, so the display's history, tabs and settings cannot reach your other machines, and
  your own Chrome on this Mac is untouched. (Safari would be different: it syncs through iCloud.)
  For the strongest isolation, run the display as its own standard macOS user that is not signed in
  to iCloud or Google.
- **Quit on purpose = stays quit.** Cmd+Q exits cleanly and isn't restarted; a crash is, after
  30 seconds. Log out and in (or `./install.sh`) to bring it back.
- **Browser:** Google Chrome, then Microsoft Edge, then Brave, then Chromium, whichever is installed.
  Safari has no kiosk flag; use Chrome.

## 4. If it doesn't come up

    tail -50 "$HOME/Library/Application Support/homedash-kiosk/kiosk.log"
    launchctl print gui/$(id -u)/com.hooptiej.homedash-kiosk | head -30

`exit 78` in the log means no supported browser was found in `/Applications`.
