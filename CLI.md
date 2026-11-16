# Aetherius CLI

`aetherius-cli` lets scripts, AI agents and people at a terminal use a running
Aetherius GCS: read and set parameters, push Lua scripts, read the console, and
download and analyze logs. It never opens a link to the vehicle itself. Every
command goes through the app and its existing connection, and shows up as one
row in the CLI panel, where it can be approved, rejected or stopped.

The installer puts `aetherius-cli.exe` next to the app and adds that folder to
PATH, so it runs from any terminal opened after installing. Terminals that were
already open need reopening. Uninstalling takes the folder off PATH again.

From a source checkout, `npm run build:cli` builds a release binary into
`src-tauri/target/release/aetherius-cli.exe`.

---

# Connecting to the app

* The CLI only works while Aetherius GCS is running with
  **Settings › CLI › CLI access** on (off by default).
* With access on, the app listens on `127.0.0.1` on a random port and writes
  `%APPDATA%\com.markw.aetherius-gcs-v3\cli.json`:

  ```json
  {"port": 47615, "token": "…", "pid": 18244, "appVersion": "0.1.0", "protocol": 1}
  ```

  The token is new every time CLI access turns on. The file is deleted when
  access is turned off; one left behind by a closed app just fails to connect.
* Each command is one TCP connection carrying JSON lines both ways. The CLI
  sends one request line (`protocol`, `token`, `command`, `args`, `argv`,
  `cwd`, `process`, `utcOffsetMinutes`, `timeoutSecs`, `noWait`). The app
  answers with `accepted`, then `state`, `progress` and `item` events, and ends
  with one `end` (or `pending` for `--no-wait`). `script push --watch` and
  `console --follow` keep the connection open, and the CLI sends `push` and
  `stop` lines on it. The types live in `src-tauri/cli/src/protocol.rs`.
* The CLI reports its own parent processes (`pwsh.exe`, `claude.exe`, …) and
  the panel shows them next to the folder. It tells callers apart; it is not
  an identity. Anything running as the same Windows user can read the token,
  so the controls that matter are the permission settings and approvals, not
  who is calling.
* If the CLI exits before the final result (Ctrl+C, the calling shell killed
  it), the app cancels the request. `--no-wait` leaves a request waiting after
  the CLI exits.

## Files and paths

* Paths on the command line are relative to the folder the CLI runs in.
* Files the CLI reads or writes (`.param` files, Lua scripts, exports) are read
  and written by the CLI process, not the app.
* Downloaded logs go to the app's log folder, the same one the Logs page uses,
  so later commands can refer to them by id.

---

# Permissions

Every command belongs to one category. **Settings › CLI › Permissions** sets
each category to Allow, Ask or Block.

| Category         | Commands                                                                                     | Default |
|------------------|----------------------------------------------------------------------------------------------|---------|
| Reads            | `status`, `params get/describe/diff/save/refresh`, `params set --dry-run`, `script ls/pull`, `console` | Allow   |
| Log files        | every `logs` command                                                                         | Allow   |
| Parameter writes | `params set`, `params apply`                                                                 | Ask     |
| Script writes    | `script push`, `script rm`, `script restart`                                                 | Ask     |
| Reboot           | `reboot`                                                                                     | Ask     |

`help`, `requests` and `--version` are always allowed. `help` and `--version`
don't need the app at all.

* **Allow** runs at once.
* **Ask** puts the request in the panel's Waiting section with Approve and
  Reject. The CLI waits.
* **Block** fails at once with `blocked`.

## While armed

A setting of its own, also Allow / Ask / Block, default **Block**. It applies
only while the vehicle is armed, and only to parameter writes, script writes,
reboot and `logs pull`. Reads and log analysis are never affected.

While the vehicle is armed, the stricter of the command's category and While
armed wins (Block over Ask over Allow):

| While armed | Effect while armed                                   |
|-------------|------------------------------------------------------|
| Allow       | The command's own category decides.                  |
| Ask         | Asks every time, even when the category is Allow.    |
| Block       | Fails with `blocked: vehicle is armed`.              |

The armed state is checked again whenever it changes:

* A request waiting for approval when the vehicle arms is checked again. Under
  Block it fails with `blocked`.
* Clicking Approve checks again before anything is sent.
* A running `script push --watch` holds pushes made while armed (Block) or
  asks for each one (Ask). Held pushes go out once the vehicle disarms.

`reboot` never sends ArduPilot's armed override, so an armed vehicle refuses
it whatever While armed is set to.

## Pause

The panel's Pause button holds new requests before they are checked. The CLI
prints `paused in Aetherius…` and keeps waiting; the time counts toward
`--timeout`. Requests already running carry on.

## Request states

These are the statuses shown in the panel.

| State     | Meaning                                              | CLI exit |
|-----------|------------------------------------------------------|----------|
| running   | Being carried out, or a `--watch`/`--follow` stream  | —        |
| waiting   | Needs approval                                       | —        |
| held      | Paused, or a watch push held while armed             | —        |
| done      | Finished                                             | 0        |
| failed    | Ran but didn't succeed                               | 1        |
| rejected  | Rejected in the panel                                | 5        |
| blocked   | Refused by a setting or the armed state              | 6        |
| expired   | Nobody answered before `--timeout`                   | 7        |
| stopped   | Stopped from the panel or with `requests stop`       | 8        |
| cancelled | The CLI went away before it finished                 | —        |

---

# Output

* Results go to stdout. Status lines (`waiting for approval in Aetherius
  (r42)…`, progress) go to stderr, so stdout can be piped. `--quiet` drops the
  status lines.
* An error is one line on stderr: `error: <code>: <message>`.
* Every request has an id like `r42`, the same id the panel uses.
* Parameter values print with the shortest decimal that gives back the
  vehicle's float32 exactly (`0.135`, not `0.13500000536`). Integer types
  print as integers.
* Wall-clock times are local `HH:MM:SS`. Log times are seconds or `m:ss.s` from
  the start of the log.

## --json

One JSON object on stdout:

```json
{"ok": true, "request": "r42", "command": "params get", "data": {}}
```

```json
{"ok": false, "request": "r43", "command": "params set",
 "error": {"code": "blocked", "reason": "armed", "message": "vehicle is armed"}}
```

Streaming commands (`--watch`, `--follow`) print one object per line with
`"event": "item"`, and end with the final object above plus `"event": "end"`.

Each command's `data` is shown with the command below.

## Exit codes

| Exit | Error codes                                                                                    | Meaning                                             |
|------|------------------------------------------------------------------------------------------------|-----------------------------------------------------|
| 0    |                                                                                                | Done                                                |
| 1    | `vehicle_error`, `link_lost`, `script_error`, `io_error`                                       | Ran but failed                                      |
| 2    | `usage`, `unknown_param`, `invalid_value`, `out_of_range`, `not_found`, `bad_file`, `not_enough_data` | Invalid request; nothing was sent             |
| 3    | `app_unavailable`, `version_mismatch`                                                          | App not running, CLI access off, or versions differ |
| 4    | `no_vehicle`                                                                                   | No vehicle connected                                |
| 5    | `rejected`                                                                                     | Rejected in the panel                               |
| 6    | `blocked`                                                                                      | Blocked by a setting or the armed state             |
| 7    | `expired`                                                                                      | Nobody answered before `--timeout`                  |
| 8    | `stopped`                                                                                      | Stopped from the panel or `requests stop`           |
| 9    | `pending`                                                                                      | `--no-wait`, and the request is waiting             |
| 130  |                                                                                                | Ctrl+C                                              |

## Global options

| Option               | Effect                                                                                   |
|----------------------|------------------------------------------------------------------------------------------|
| `--json`             | JSON output                                                                              |
| `--timeout DURATION` | How long to wait for approval. Default `10m`; `0` waits forever. `30s`, `5m`, `1h`.      |
| `--no-wait`          | Return as soon as the request is waiting (exit 9). Finish it later with `requests wait`. |
| `--quiet`            | No status lines on stderr                                                                |
| `--help`             | Same as `help COMMAND` for the command it follows                                        |
| `--version`          |                                                                                          |

---

# Commands

```
aetherius-cli status
aetherius-cli params    get | describe | set | diff | apply | save | refresh
aetherius-cli script    ls | pull | push | rm | restart
aetherius-cli console
aetherius-cli logs      ls | pull | local | info | schema | series | events | segments
                        stats | fft | track-error | eval | export
aetherius-cli reboot
aetherius-cli requests  ls | show | wait | stop
aetherius-cli help      [COMMAND] [--json] | errors
```

Commands that talk to the vehicle fail with `no_vehicle` (exit 4) when nothing
is connected. `status`, `requests`, `help`, and log analysis given a file path
work without a vehicle.

## help

```
aetherius-cli help [COMMAND] [--json]
aetherius-cli help errors
aetherius-cli COMMAND --help
```

Built into the CLI: it works without the app running and doesn't show up in
the panel. It is generated from the same definitions the CLI parses arguments
with and the app builds replies from, so it can't drift from what the commands
actually do.

### help

Every command with a one-line summary and its permission category (`reads`,
`logs`, `params`, `scripts`, `reboot`). `armed` means While armed applies too.

```
$ aetherius-cli help
Use a running Aetherius GCS from a terminal.

status                           link, vehicle and CLI settings          reads
params get NAME|PATTERN...       parameter values                        reads
params describe NAME|PATTERN...  parameter documentation                 reads
params set NAME=VALUE...         change parameters                       params, armed
params diff FILE                 compare a .param file with the vehicle  reads
params apply FILE                apply a .param file                     params, armed
params save FILE [PATTERN...]    save parameters to a .param file        reads
params refresh                   fetch every parameter again             reads
script ls [DIR]                  scripts on the vehicle                  reads
script pull REMOTE [LOCAL]       copy a script from the vehicle          reads
script push LOCAL...             upload scripts, restart scripting       scripts, armed
script push --watch DIR          upload on every save                    scripts, armed
script rm REMOTE                 delete a script                         scripts, armed
script restart                   restart scripting                       scripts, armed
console                          vehicle text messages                   reads
logs ls                          logs on the vehicle                     logs
logs pull ID|latest              download a log                          logs, armed
logs local                       downloaded logs                         logs
logs info LOG                    file, firmware, duration                logs
logs schema LOG [MSG]            message types and fields                logs
logs series LOG FIELDS           values over time                        logs
logs events LOG [TYPE...]        messages, errors, events, modes         logs
logs segments LOG                modes and armed state over time         logs
logs stats LOG FIELDS            min, max, mean, rms, percentiles        logs
logs fft LOG FIELDS              frequency peaks                         logs
logs track-error LOG DES,ACT     how well one field follows another      logs
logs eval LOG "EXPR"             expression over fields                  logs
logs export LOG FIELDS --out F   full-rate data to a file                logs
reboot                           reboot and wait for the link            reboot, armed
requests ls|show|wait|stop       requests in this app session            always
help [COMMAND] [--json]          this list, or one command in detail     always

options   --json  --timeout DURATION  --no-wait  --quiet  --version
more      help COMMAND · help errors · help --json
```

### help COMMAND

The same as `COMMAND --help`: synopsis, what it does, category, arguments,
options, the errors it can return, an example, and the `--json` data fields.
Streaming commands also list their item fields.

```
$ aetherius-cli help params set
params set NAME=VALUE... [--dry-run] [--allow-out-of-range]

Change one or more parameters. Every value is checked before anything is sent.

category    parameter writes · while armed applies
arguments   NAME=VALUE...           one or more; exact names
options     --dry-run               check and show the changes, send nothing (counts as reads)
            --allow-out-of-range    allow values outside the documented range; always asks
errors      unknown_param  invalid_value  out_of_range  no_vehicle
            blocked  rejected  expired  vehicle_error

example
  $ aetherius-cli params set INS_HNTCH_FREQ=160 INS_HNTCH_BW=80
  INS_HNTCH_FREQ   80 → 160
  INS_HNTCH_BW     40 → 80
  applied 2 of 2

data (--json)
  changes[]       name string · from number · to number · confirmed boolean
  unchanged[]     string
  applied         integer
  total           integer
  rebootNeeded    boolean
  dryRun          boolean
```

### help errors

```
$ aetherius-cli help errors
exit  code              meaning
0                       done
1     vehicle_error     the vehicle refused or didn't confirm
1     link_lost         the link dropped mid-command
1     script_error      Lua errors after a restart
1     io_error          a local file couldn't be read or written
2     usage             bad arguments
2     unknown_param     no parameter by that name
2     invalid_value     not a valid value for that parameter
2     out_of_range      outside the documented range
2     not_found         no such file, log or vehicle path
2     bad_file          a file with nothing usable in it
2     not_enough_data   the range is too short for the analysis
3     app_unavailable   app not running, or CLI access off
3     version_mismatch  CLI and app versions don't match
4     no_vehicle        no vehicle connected
5     rejected          rejected in the app
6     blocked           blocked by a setting or the armed state
7     expired           nobody answered before --timeout
8     stopped           stopped in the app
9     pending           --no-wait, and the request is waiting
130                     Ctrl+C
```

### help --json

Everything above as one object, for agents and scripts. Each command lists
its arguments and options with types, its category, whether While armed
applies, whether it needs a vehicle, whether it streams, the errors it can
return, and its `data` (and `item`) shape as JSON Schema. `help COMMAND
--json` gives one command's entry.

Argument types: `name`, `pattern`, `assignment` (`NAME=VALUE`), `path`,
`remote-path`, `log`, `fields`, `expr`, `time`, `duration`, `integer`.

```json
{"cli": "0.1.0", "protocol": 1,
 "globalOptions": [
   {"name": "--json", "type": "flag"},
   {"name": "--timeout", "type": "duration", "default": "10m"},
   {"name": "--no-wait", "type": "flag"},
   {"name": "--quiet", "type": "flag"}],
 "errors": [
   {"code": "blocked", "exit": 6, "meaning": "blocked by a setting or the armed state"}],
 "commands": [
   {"name": "params set",
    "synopsis": "params set NAME=VALUE... [--dry-run] [--allow-out-of-range]",
    "summary": "Change one or more parameters",
    "category": "params", "whileArmed": true, "needsVehicle": true, "streams": false,
    "args": [{"name": "NAME=VALUE", "type": "assignment", "required": true, "repeat": true}],
    "options": [{"name": "--dry-run", "type": "flag"},
                {"name": "--allow-out-of-range", "type": "flag"}],
    "errors": ["unknown_param", "invalid_value", "out_of_range", "no_vehicle",
               "blocked", "rejected", "expired", "vehicle_error"],
    "data": {"type": "object", "properties": {
      "changes": {"type": "array", "items": {"type": "object", "properties": {
        "name": {"type": "string"}, "from": {"type": "number"},
        "to": {"type": "number"}, "confirmed": {"type": "boolean"}}}},
      "unchanged": {"type": "array", "items": {"type": "string"}},
      "applied": {"type": "integer"}, "total": {"type": "integer"},
      "rebootNeeded": {"type": "boolean"}, "dryRun": {"type": "boolean"}}}}]}
```

## status

```
aetherius-cli status
```

Reads.

```
link        COM5 · CubeOrange
firmware    ArduCopter V4.6.2
state       disarmed · Loiter
params      1043 loaded
cli         reads allow · logs allow · params ask · scripts ask · reboot ask · while armed block
```

With nothing connected, `link` is `none` and the vehicle lines are left out.

```json
{"link": {"endpoint": "COM5", "board": "CubeOrange"},
 "firmware": "ArduCopter V4.6.2", "vehicle": "copter",
 "armed": false, "mode": "Loiter",
 "params": {"loaded": 1043, "total": 1043},
 "permissions": {"reads": "allow", "logs": "allow", "params": "ask",
                 "scripts": "ask", "reboot": "ask", "whileArmed": "block"}}
```

`link` is `null` when nothing is connected.

## params

Values come from the app's parameter cache, which is filled when the link
connects. If that fetch is still running, read commands wait for it
(`loading parameters 812/1043…` on stderr).

`NAME` is an exact parameter name. `PATTERN` accepts `*` and `?` and ignores
case: `'ATC_RAT_*'`. Quote patterns in bash; PowerShell passes them through
as they are.

Parameter files use the `.param` format the app already reads and writes:
`NAME,VALUE` per line, `#` comments. Mission Planner, QGroundControl and
MAVProxy use the same format.

### params get

```
aetherius-cli params get NAME|PATTERN...
```

Reads.

```
$ aetherius-cli params get 'INS_HNTCH_*' ATC_RAT_RLL_P
ATC_RAT_RLL_P      0.135
INS_HNTCH_ATT      40      dB
INS_HNTCH_BW       40      Hz
INS_HNTCH_ENABLE   1
INS_HNTCH_FREQ     80      Hz
INS_HNTCH_HMNCS    3
INS_HNTCH_MODE     1
INS_HNTCH_OPTS     0
INS_HNTCH_REF      0
9 parameters
```

`params get '*'` lists everything. A `NAME` the vehicle doesn't have is listed
under `missing` and the rest are still shown; the command fails with
`unknown_param` only if nothing else was found. A `PATTERN` that matches
nothing gives an empty list. `params describe` works the same way.

```json
{"params": [{"name": "INS_HNTCH_FREQ", "value": 80, "type": "REAL32", "units": "Hz"}],
 "missing": ["INS_HNTCH_FRQ"]}
```

### params describe

```
aetherius-cli params describe NAME|PATTERN...
```

Reads. Documentation from the ArduPilot parameter metadata the app ships
(`public/params/*.json`), plus the current value.

```
$ aetherius-cli params describe INS_HNTCH_FREQ
INS_HNTCH_FREQ   Harmonic Notch Filter base frequency
value            80 Hz
range            10 – 495 Hz
level            Advanced

Harmonic Notch Filter base center frequency in Hz. This is the center
frequency for static notches, the center frequency for Throttle based notches
at the reference thrust value, and the minimum limit of center frequency
variation for all other notch types. ...
```

Parameters with a list of values show it (`0 Disabled · 1 Enabled`). Bitmask
parameters list every bit and mark the ones that are set.

```json
{"params": [{"name": "INS_HNTCH_FREQ",
             "humanName": "Harmonic Notch Filter base frequency",
             "description": "…", "value": 80, "units": "Hz",
             "range": [10, 495], "increment": null,
             "values": null, "bitmask": null, "level": "Advanced"}]}
```

### params set

```
aetherius-cli params set NAME=VALUE... [--dry-run] [--allow-out-of-range]
```

Parameter writes, and While armed. `--dry-run` counts as Reads.

Everything is checked before anything is sent. One bad value fails the whole
request:

* a name the vehicle doesn't have: `unknown_param`
* not a number, a fraction for an integer parameter, a value not in the
  parameter's list, or a bit the bitmask doesn't define: `invalid_value`
* outside the documented range: `out_of_range`. With `--allow-out-of-range`
  it goes through, but always asks, whatever Parameter writes is set to, and
  the panel marks the value.

Values equal to the current ones are dropped. If nothing is left, the command
finishes without asking.

The panel shows Current, New and Range for approval. Each value is sent with
`PARAM_SET` and counts as applied once the vehicle's `PARAM_VALUE` echo
confirms it.

```
$ aetherius-cli params set INS_HNTCH_FREQ=160 INS_HNTCH_BW=80 INS_HNTCH_REF=0.24
waiting for approval in Aetherius (r42)…
INS_HNTCH_FREQ   80 → 160
INS_HNTCH_BW     40 → 80
INS_HNTCH_REF     0 → 0.24
applied 3 of 3
```

If the vehicle doesn't confirm a value, that line says `not confirmed`, the
last line says `applied 2 of 3`, and the command fails with `vehicle_error`.
If any changed parameter needs a reboot to take effect, a last line says
`reboot needed`. `--dry-run` prints the same table and ends with
`dry run, nothing sent`.

```json
{"changes": [{"name": "INS_HNTCH_FREQ", "from": 80, "to": 160, "confirmed": true}],
 "unchanged": [], "applied": 3, "total": 3, "rebootNeeded": false, "dryRun": false}
```

### params diff

```
aetherius-cli params diff FILE
```

Reads. Compares a `.param` file with the live values.

```
$ aetherius-cli params diff tuned.param
ATC_RAT_RLL_P    0.135 → 0.15
INS_HNTCH_FREQ   80 → 160
2 differ · 1041 same · 1 not on vehicle (GND_EFFECT_COMP)
```

Fails with `not_found` if the file doesn't exist and `bad_file` if it has no
valid lines.

```json
{"differ": [{"name": "ATC_RAT_RLL_P", "live": 0.135, "file": 0.15}],
 "same": 1041, "missing": ["GND_EFFECT_COMP"]}
```

### params apply

```
aetherius-cli params apply FILE [--only PATTERN...] [--allow-out-of-range]
```

Parameter writes, and While armed. The same as `params set` with every value in
the file that differs from the vehicle, or only those matching `--only`. Names
the vehicle doesn't have are listed and skipped. Checks, approval, output and
`data` are the same as `params set`. For a long list, the panel's "Open in
Parameters" opens the app's own load review.

### params save

```
aetherius-cli params save FILE [PATTERN...] [--force]
```

Reads. Writes live values to a `.param` file in the same format the
Parameters page saves. Won't overwrite an existing file without `--force`.

```
saved 1043 parameters to C:\Users\markw\notch-tune\before.param
```

```json
{"path": "C:\\Users\\markw\\notch-tune\\before.param", "count": 1043}
```

### params refresh

```
aetherius-cli params refresh
```

Reads. Fetches every parameter from the vehicle again, with progress on
stderr.

```
1043 parameters loaded
```

```json
{"loaded": 1043, "total": 1043}
```

## script

Vehicle paths are under `APM/scripts` on the SD card, over MAVLink FTP.
`foo.lua`, `APM/scripts/foo.lua` and `/APM/scripts/foo.lua` all mean the same
file.

`script push`, `script rm` and `script restart` restart scripting afterwards
(unless `--no-restart`) and then watch the console for 3 seconds. Any Lua error
in that time is printed and the command fails with `script_error`. If the
firmware can't restart scripting on request, the reply says `reboot to load`
instead.

### script ls

```
aetherius-cli script ls [DIR]
```

Reads.

```
$ aetherius-cli script ls
batt_warn.lua      1.2 KB
vibe_watch.lua     214 B
modules/
```

```json
{"dir": "APM/scripts",
 "entries": [{"name": "batt_warn.lua", "bytes": 1228, "dir": false},
             {"name": "modules", "bytes": null, "dir": true}]}
```

### script pull

```
aetherius-cli script pull REMOTE [LOCAL] [--force]
```

Reads. `LOCAL` defaults to the file's name in the current folder. Won't
overwrite without `--force`.

```
pulled APM/scripts/batt_warn.lua → .\batt_warn.lua (1.2 KB)
```

```json
{"remote": "APM/scripts/batt_warn.lua", "local": "C:\\Users\\markw\\scripts\\batt_warn.lua", "bytes": 1228}
```

### script push

```
aetherius-cli script push LOCAL... [--to DIR] [--no-restart]
```

Script writes, and While armed. The panel shows each file as a diff against the
vehicle's copy, or as a new file.

```
$ aetherius-cli script push vibe_watch.lua
waiting for approval in Aetherius (r44)…
uploaded vibe_watch.lua → APM/scripts/vibe_watch.lua (214 B, new)
scripting restarted
no Lua errors
```

With an error:

```
uploaded vibe_watch.lua → APM/scripts/vibe_watch.lua (214 B)
scripting restarted
Lua: APM/scripts/vibe_watch.lua:6: attempt to call a nil value (field 'send_txt')
error: script_error: 1 Lua error after restart
```

```json
{"files": [{"local": "vibe_watch.lua", "remote": "APM/scripts/vibe_watch.lua",
            "bytes": 214, "new": true}],
 "restarted": true, "luaErrors": []}
```

### script push --watch

```
aetherius-cli script push --watch DIR [--to DIR]
```

Script writes, and While armed. One request for the whole session: if Script
writes is Ask, it is approved once. After that, every `.lua` file saved in
`DIR` is pushed (after 500 ms without further changes) and scripting is
restarted. It runs until Ctrl+C (exit 130) or Stop in the panel (exit 8).

Files already in `DIR` when the watch starts aren't pushed; run `script push`
first if they need to be. Deleting a file locally doesn't delete it on the
vehicle.

```
$ aetherius-cli script push --watch ./scripts
watching .\scripts → APM/scripts
waiting for approval in Aetherius (r45)…
13:55:40  batt_warn.lua   pushed
13:56:20  batt_warn.lua   pushed
13:58:05  batt_warn.lua   held: vehicle armed
14:00:52  batt_warn.lua   pushed (was held)
14:06:18  batt_warn.lua   pushed
^C
stopped · 4 pushed · 1 held
```

A push followed by a Lua error prints the error on that push's line, and the
watch keeps going.

```json
{"request": "r45", "event": "item",
 "data": {"time": "13:58:05", "file": "batt_warn.lua", "result": "held", "reason": "armed", "luaErrors": []}}
```

```json
{"ok": true, "request": "r45", "command": "script push", "event": "end",
 "data": {"pushed": 4, "held": 1}}
```

### script rm

```
aetherius-cli script rm REMOTE [--no-restart]
```

Script writes, and While armed.

```
removed APM/scripts/old_test.lua
scripting restarted
```

```json
{"removed": "APM/scripts/old_test.lua", "restarted": true, "luaErrors": []}
```

### script restart

```
aetherius-cli script restart
```

Script writes, and While armed.

```
scripting restarted
no Lua errors
```

```json
{"restarted": true, "luaErrors": []}
```

## console

```
aetherius-cli console [--last N] [--since TIME] [--level LEVEL] [--grep TEXT] [--follow]
```

Reads. The vehicle's text messages (`STATUSTEXT`), the same ones the Console
panel shows, from the last 2000 since the app started.

* `--last N`: the last N messages. Default 50.
* `--since TIME`: `HH:MM:SS`, or a time back from now (`5m`).
* `--level LEVEL`: lowest severity to show: `emergency`, `alert`, `critical`,
  `error`, `warning`, `notice`, `info`, `debug`.
* `--grep TEXT`: only messages containing TEXT, ignoring case.
* `--follow`: keep printing new messages until Ctrl+C or Stop. Shown as
  running in the panel.

```
$ aetherius-cli console --since 5m --level warning
14:02:11  warning   PreArm: Compass not calibrated
14:06:19  error     Lua: APM/scripts/batt_warn.lua:12: unexpected symbol near 'end'
```

```json
{"messages": [{"time": "14:02:11", "severity": "warning", "text": "PreArm: Compass not calibrated"}]}
```

With `--follow`, each message is an `"event": "item"` line.

## logs

Downloaded logs are kept per vehicle in
`%APPDATA%\com.markw.aetherius-gcs-v3\<board UID>\logs\`, and nothing deletes
them. ArduPilot reuses log numbers once logs are erased, so a later log with
the same number is saved next to the earlier one (`00000042.bin`,
`00000042-2.bin`, …) instead of replacing it.

`LOG` is one of:

* an id (`42`): the downloaded copy of the log the connected vehicle
  currently has under that number, matched by number and size
* `latest`: the connected vehicle's newest downloaded log
* a file name from `logs local` (`00000042-2.bin`), for the connected vehicle
* a path to any `.bin` file, which works without a vehicle

`FIELD` is `MSG.Field`. Messages with several instances take the instance in
brackets: `IMU[1].GyrX` (default instance 0). List several with commas:
`RATE.RDes,RATE.R`.

Time range options, accepted by `series`, `stats`, `fft`, `track-error`,
`eval` and `export`:

| Option           | Range                                                              |
|------------------|--------------------------------------------------------------------|
| `--from T`, `--to T` | Log time in seconds or `m:ss`                                  |
| `--mode NAME[#N]`| The Nth time the vehicle was in that mode (default the first)      |
| `--armed`        | Only while armed                                                   |

All analysis runs on full-rate data. Only the output is shortened.

### logs ls

```
aetherius-cli logs ls
```

Log files. Logs on the vehicle.

```
id   date               size
40   2026-11-12 16:20   12.4 MB
41   2026-11-13 13:41    1.1 MB
42   2026-11-13 13:53   38.2 MB
```

```json
{"logs": [{"id": 42, "time": "2026-11-13T13:53:00", "bytes": 40055603}]}
```

`time` is `null` for logs recorded without a GPS time.

### logs pull

```
aetherius-cli logs pull ID|latest
```

Log files, and While armed. Downloads into the vehicle's log folder, with
progress on stderr. A log that's already downloaded returns at once. If a
different log is already saved under that number, the new one gets the next
free name and the reply says so (`saved as 00000042-2.bin, 00000042.bin is an
earlier log`).

```
pulled log 42 → 00000042.bin (38.2 MB, 18.4 s)
```

```json
{"id": 42, "path": "…\\logs\\00000042.bin", "bytes": 40055603, "seconds": 18.4, "alreadySaved": false}
```

### logs local

```
aetherius-cli logs local
```

Log files. Logs already downloaded for the connected vehicle, oldest first.
`on vehicle` marks the ones that match a log the vehicle still has.

```
id   file             size      downloaded         on vehicle
42   00000042.bin     12.9 MB   2026-10-02 18:11
42   00000042-2.bin   38.2 MB   2026-11-13 14:02   yes
```

```json
{"logs": [{"id": 42, "file": "00000042-2.bin", "bytes": 40055603,
           "downloaded": "2026-11-13T14:02:38", "onVehicle": true}]}
```

### logs info

```
aetherius-cli logs info LOG
```

Log files.

```
file        00000042.bin · 38.2 MB
vehicle     ArduCopter V4.6.2 · CubeOrange
start       2026-11-13 13:53:50
duration    7:20
messages    214 types · 2,184,330 records
```

```json
{"file": "00000042.bin", "bytes": 40055603, "firmware": "ArduCopter V4.6.2",
 "board": "CubeOrange", "start": "2026-11-13T13:53:50", "duration": 440.2,
 "types": 214, "records": 2184330}
```

### logs schema

```
aetherius-cli logs schema LOG [MSG]
```

Log files. Without `MSG`, every message type with its rate and fields. With
`MSG`, that message's fields and units.

```
$ aetherius-cli logs schema 42 RATE
RATE   400 Hz   114,820 records
field   unit
RDes    deg/s
R       deg/s
ROut
PDes    deg/s
...
```

```json
{"messages": [{"name": "RATE", "rate": 400, "count": 114820,
               "fields": [{"name": "RDes", "unit": "deg/s"}]}]}
```

### logs series

```
aetherius-cli logs series LOG FIELD[,FIELD...] [range] [--rate HZ] [--max N]
```

Log files. Values over time. Fields from different messages are lined up on
the first field's timestamps (linear interpolation), or on a fixed rate with
`--rate`. If there are more rows than `--max` (default 200), they are averaged
into equal time slices and the last line says so. Averaging flattens spikes;
use `logs stats` for extremes.

```
$ aetherius-cli logs series 42 RATE.RDes,RATE.R --mode Loiter --max 5
t        RATE.RDes   RATE.R
2:10.0     0.0         0.4
3:07.0     2.1         1.6
4:04.0    -0.8        -1.1
5:01.0     0.3         0.9
5:58.0     0.0        -0.2
5 rows · averaged from 113,950 samples
```

```json
{"columns": ["t", "RATE.RDes", "RATE.R"],
 "rows": [[130.0, 0.0, 0.4]],
 "samples": 113950, "averaged": true}
```

### logs events

```
aetherius-cli logs events LOG [TYPE...]
```

Log files. `TYPE` is `MSG` (text messages), `ERR` (subsystem errors), `EV`
(events) or `MODE`. Default all four.

```
0:00.0   MSG    ArduCopter V4.6.2
0:41.2   MODE   AltHold
1:02.7   EV     armed
6:58.1   ERR    FAILSAFE_BATT 1
```

```json
{"events": [{"t": 41.2, "type": "MODE", "text": "AltHold"}]}
```

### logs segments

```
aetherius-cli logs segments LOG
```

Log files. Flight modes and armed state over the log.

```
mode        from    to      armed
Stabilize   0:00    0:41    no
AltHold     0:41    2:10    yes
Loiter      2:10    6:55    yes
Land        6:55    7:20    yes
```

```json
{"segments": [{"mode": "Loiter", "from": 130.0, "to": 415.0, "armed": true}]}
```

### logs stats

```
aetherius-cli logs stats LOG FIELD[,FIELD...] [range]
```

Log files.

```
$ aetherius-cli logs stats 42 VIBE.VibeX,VIBE.VibeY,VIBE.VibeZ --mode Loiter
field        n      min    max    mean   rms    p95
VIBE.VibeX   2850   3.1    18.4   7.2    7.9    12.6
VIBE.VibeY   2850   2.8    16.9   6.8    7.4    11.9
VIBE.VibeZ   2850   5.6    29.3   12.1   13.0   21.4
```

```json
{"fields": [{"field": "VIBE.VibeX", "n": 2850, "min": 3.1, "max": 18.4,
             "mean": 7.2, "rms": 7.9, "std": 3.0, "p5": 4.0, "p50": 6.9, "p95": 12.6}]}
```

### logs fft

```
aetherius-cli logs fft LOG FIELD[,FIELD...] [range] [--peaks N] [--bins N] [--nfft N]
```

Log files. Power spectrum (Welch: Hann window, 1024-point segments by default,
50% overlap). Shows the sample rate, the frequency resolution and the top
`--peaks` peaks per field (default 3). `--bins N` adds the spectrum averaged
into N bins. Fails with `not_enough_data` if the range is shorter than one
segment.

```
$ aetherius-cli logs fft 42 IMU.GyrX,IMU.GyrY --mode Loiter
sample rate 1000 Hz · resolution 0.98 Hz · 285 s
field      peak 1           peak 2           peak 3
IMU.GyrX   162 Hz  −18 dB   324 Hz  −31 dB   487 Hz  −44 dB
IMU.GyrY   162 Hz  −21 dB   324 Hz  −34 dB   —
```

```json
{"sampleRate": 1000, "resolution": 0.98, "seconds": 285,
 "fields": [{"field": "IMU.GyrX",
             "peaks": [{"hz": 162, "db": -18}, {"hz": 324, "db": -31}],
             "bins": null}]}
```

### logs track-error

```
aetherius-cli logs track-error LOG DESIRED,ACTUAL [range]
```

Log files. How well `ACTUAL` follows `DESIRED`, lined up on `DESIRED`'s
timestamps. Lag is the delay with the highest cross-correlation.

```
$ aetherius-cli logs track-error 42 RATE.RDes,RATE.R --mode Loiter
rms 4.1 deg/s · max 22.6 deg/s · mean 0.2 deg/s · lag 18 ms · 113,950 samples
```

```json
{"rms": 4.1, "max": 22.6, "mean": 0.2, "lagMs": 18, "samples": 113950, "units": "deg/s"}
```

### logs eval

```
aetherius-cli logs eval LOG "EXPR" [range] [--stats | --series | --fft]
```

Log files. Works out an expression over fields, lined up on the first field's
timestamps, and shows it like `stats` (default), `series` or `fft`, with those
commands' options.

Expressions use fields, numbers, `+ - * / ^`, parentheses, and `abs sqrt sin
cos atan2 hypot min max deg rad`, plus `diff(x)` (rate of change per second)
and `lpf(x, HZ)` (low-pass filter).

```
$ aetherius-cli logs eval 42 "hypot(VIBE.VibeX, VIBE.VibeY)" --mode Loiter
n      min   max    mean   rms    p95
2850   4.4   24.1   10.3   11.2   17.9
```

`data` is the same as the output mode's command.

### logs export

```
aetherius-cli logs export LOG FIELD[,FIELD...] --out FILE [range] [--rate HZ] [--format csv|jsonl] [--force]
```

Log files. Full-rate data to a file, for analysis the commands above don't
cover. The first column is `t_us`. Won't overwrite without `--force`.

Rows follow the first field's samples (or `--rate`). Fields from the same
message and instance come from the same records. Other numbers are
interpolated; other text holds its latest value. Text fields such as
`PARM.Name` and `MSG.Message` export as text, quoted in CSV where needed.

```
exported 113,950 rows → rate.csv
```

```
$ aetherius-cli logs export 42 PARM.Name,PARM.Value --out params.csv
exported 1,043 rows → params.csv
```

```json
{"path": "C:\\Users\\markw\\notch-tune\\rate.csv", "rows": 113950, "columns": ["t_us", "RATE.RDes", "RATE.R"]}
```

## reboot

```
aetherius-cli reboot [--no-reconnect]
```

Reboot, and While armed. Waits up to 60 s for the link to come back and the
parameters to reload, unless `--no-reconnect`.

```
waiting for approval in Aetherius (r50)…
rebooting
link back after 9.8 s · 1043 parameters loaded
```

Never sends ArduPilot's armed override. An armed vehicle refuses the reboot,
and the command fails with `vehicle_error: reboot refused while armed`.

```json
{"reconnected": true, "seconds": 9.8, "params": 1043}
```

## requests

Always allowed. Covers requests from the current app session.

### requests ls

```
aetherius-cli requests ls [--all]
```

Waiting and running requests; `--all` adds finished ones.

```
id    time      state     command
r42   14:04:12  waiting   params set INS_HNTCH_FREQ=160 INS_HNTCH_BW=80 INS_HNTCH_REF=0.24
r45   13:55:10  running   script push --watch ./scripts
```

```json
{"requests": [{"id": "r42", "time": "14:04:12", "state": "waiting",
               "command": "params set INS_HNTCH_FREQ=160 INS_HNTCH_BW=80 INS_HNTCH_REF=0.24",
               "folder": "C:\\Users\\markw\\notch-tune"}]}
```

### requests show

```
aetherius-cli requests show ID
```

A finished request's reply, printed the way the original command printed it.

### requests wait

```
aetherius-cli requests wait ID
```

Waits for a request started with `--no-wait`, then prints its reply and exits
with the code the original command would have used.

### requests stop

```
aetherius-cli requests stop ID
```

Stops a waiting or running request, the same as Stop in the panel. If the
original CLI is still connected, it gets `stopped` (exit 8).

```
stopped r45
```

---

# Not in the CLI

These are deliberately left out. They have no commands, so no setting can turn
them on:

* Arm and disarm, mode changes, takeoff
* Mission start, pause and resume
* Motor tests, RC override, servo and relay control
* Calibration
* Firmware flashing

Could come later, with a permission category of their own: mission, fence and
rally download and upload.

---

# How it's built

* **`src-tauri/cli/`** — the `aetherius-cli` crate, a workspace member. Its
  library half is the one definition of every command (`catalog.rs`: names,
  arguments, categories, reply shapes in a small notation `shape.rs` turns
  into help text and JSON Schema), the argument parser (`parse.rs`) and the
  wire protocol (`protocol.rs`). The binary half adds help output, local file
  handling, human formatting and the watch loop. The app depends on the
  library, so the server and the CLI can't disagree about a command.
* **`src-tauri/src/cli/`** — the control server inside the app. `server.rs`
  listens and reads requests, `ctx.rs` runs the permission check and approval
  wait every handler goes through, `requests.rs` keeps the request log the
  panel shows (as `cli-activity` events) and appends finished requests to
  `%APPDATA%\com.markw.aetherius-gcs-v3\cli\YYYY-MM-DD.jsonl`, and
  `handlers/` holds one function per command, calling the app's existing
  parameter, FTP, log and reboot code.
* **Console buffer** (`cli/console.rs`): the backend keeps the last 2000
  STATUSTEXT messages since the app started, for `console` and for the Lua
  error check after a push.
* **Full-rate analysis** (`handlers/analysis.rs`, `handlers/expr.rs`): stats,
  Welch FFT, track error and `eval` run on every sample in range; only output
  is shortened.
* **Armed checks**: a write is checked when it's requested, while it waits
  (every 100 ms), and again on approval.
* **Frontend**: the CLI panel (`src/panels/cli/`), Settings › CLI, and
  `src/lib/cli/cli.ts`, which keeps the panel's copy of every request.
* **Installer**: `scripts/build-cli.mjs` runs before `tauri dev` and
  `tauri build`. It builds the CLI and copies it to
  `src-tauri/binaries/aetherius-cli-<target triple>.exe`, where
  `bundle.externalBin` picks it up. Tauri copies external binaries on every
  build, dev included, and fails if one is missing.
* **PATH**: the NSIS installer (`src-tauri/windows/hooks.nsh`) runs
  `aetherius-cli --add-to-path` after installing and `--remove-from-path`
  before uninstalling. These edit the user PATH (`HKCU\Environment`) from
  `cli/src/install.rs`, keeping the value's type and any `%VARS%` in it.
  NSIS can't do this itself, because its strings stop at 1024 characters,
  shorter than many PATHs. The MSI adds the folder to the system PATH through
  `src-tauri/windows/cli-path.wxs`. Both flags are left out of help.
