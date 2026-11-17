# Machines

The editor itself targets an abstract pen plotter: everything upstream of output speaks
machine-neutral terms - positions in page millimeters, a pen index, a pressure from 0 to 1.
A **machine profile** is what turns that into physical motion. Profiles are editable copies seeded
from a preset, and a profile's *kind* (G-code plotter, AxiDraw, GRBL, or HP-GL) comes from that preset.
This page is about setting a machine up; day-to-day plotting - pens, stroke order, preview,
exports - is covered in [plotting](plotting.md).

Common to all kinds:

- **Bed** - the plottable area in mm. The canvas page is exactly the bed.
- **Pens** - the palette. Colors are display-only (a plotter draws with whatever you clamp into
  it); what matters is that list order is plot order, and the job pauses between pens so you can
  swap.
- **Fiducial** - an optional registration point. The plot first travels there and pauses, so you
  can line up the paper before the first stroke.

## G-code plotters (`prusa` kind)

Built for a 3D printer with a pen in a spring-loaded holder, but any G-code machine with X/Y motion
and a Z axis fits.

- **Pen offset.** The pen sits away from the nozzle; G-code commands the nozzle, so every commanded
  coordinate is `pen target − offset`, including Z. The area the pen can actually reach (the bed
  intersected with its offset copy) is the drawable region - anything outside is greyed out in the
  editor and clipped from the job.
- **Pen Z.** `up` is travel height, `down` is full pressure. An optional `downLight` (the lightest
  touch) switches per-element pressure on: pressure 0..1 interpolates `downLight` to `down`, and Z
  ramps along a stroke only where pressure actually changes. Without `downLight`, the pen is
  strictly up/down and the pressure control is disabled.
- **Origin.** Bottom-left for most printers; the page-to-machine transform flips Y accordingly. The
  editor always shows top-left/+Y-down page space - only the emitted coordinates and the status-bar
  readout are origin-aware.
- **Preamble / postamble** - machine init and shutdown, verbatim. The initial pen-up is emitted by
  the app (offset-correct); the postamble ends with a high clearance lift on purpose.
- **Pause** - an operator-pause macro with a `{message}` placeholder (e.g. `M0`), used for pen
  swaps and the fiducial stop. Leave it empty for machines with no way to pause.

## EBB plotters (`axidraw` kind)

AxiDraw machines and EBB-compatible plotters like the iDraw family. The app is the whole
toolchain for this kind: it plans the motion itself - trapezoidal acceleration,
junction-deviation cornering - and streams it to the EBB board live over Web Serial. Plotting
happens with the Plot button; there is no exported file in between.

- **No endstops.** Home is wherever you park the carriage (top-left, against both stops); the
  board's step counters are zeroed there when a plot starts, and position is dead-reckoned from
  then on.
  Every job - including a cancelled one - ends by walking back to home. If the connection drops
  mid-plot, re-park before plotting again.
- **Pausing lands at rest.** The plan guarantees zero-velocity points at least every few seconds;
  pause (from the app or the board's button) takes effect at the next one, so resume is exact.
- **Pauses prompt in the app.** There is no LCD, so pen swaps and the fiducial stop drain the
  motion queue and raise a dialog instead.
- **Motion and servo settings** - speeds, acceleration, cornering tolerance, servo up/down
  positions and timing - live on the profile and are editable like everything else.

## GRBL plotters (`grbl` kind)

Covers the wide world of GRBL 1.1 machines - EleksDraw-style servo plotters, CNC conversions,
homebuilt CoreXY frames. Two outputs from the same job: download GRBL-flavored G-code for any
sender, or stream it live over Web Serial (the file and the stream are byte-for-byte the same
moves). Unlike the AxiDraw, the firmware does its own motion planning - the app just streams
lines and follows along.

- **Pen actuation is a choice.** A real Z axis (with the same `up`/`down`/`downLight` pressure
  model as G-code plotters), or a servo on the spindle-PWM pin driven with `M3 S…` - the common
  cheap-plotter setup. Servo `S` semantics vary between firmware forks; the profile's pen-test
  button is there to dial the values in.
- **Homing is a choice.** With limit switches, enable *Home first* and every job starts from `$H`.
  Without them (most hobby plotters), the job's origin is wherever the pen sits when it starts -
  park it at the page origin, like an AxiDraw. Either way the work zero is written with `G10 L20`,
  so even a cancelled job can walk back home.
- **Diode lasers work too.** On GRBL in laser mode (`$32=1`) the servo pen's `M3 S` is laser
  power: up `S0` = off, down = power (out of `$30`), settle times 0 so no dwell burns a dot. Pick
  *Atomstack A5 Pro+ (dry run, laser off)* to trace a job with the beam off - every pen-down is
  sent as `S0`, whatever the power setting says - and *Atomstack A5 Pro+ (LASER)* to burn. Both
  home first (endstops front-left; switch the origin to top-left for back-left switches). The
  *Dry run* checkbox in Machine settings flips any laser profile between the two. While the laser
  is armed, a red banner sits in Machine settings, the plot bar shows *Laser on*, and plotting,
  generating G-code and the pen test each ask you to confirm a red warning first. Laser output is
  on/off only - no pressure, no per-pen power.
- **The live view follows the machine.** While streaming, the board's own position reports drive
  the playhead and progress - what you see is where the pen actually is, not an estimate.
- **Pausing lands between strokes** (pen up, queue drained), so resume is exact. Stopping a plot
  feed-holds, resets the controller, lifts the pen, and returns to the origin.
- **Connection.** Streaming uses Web Serial at the profile's baud rate (default 115200). GRBL
  boards have no fixed USB identity, so the port picker shows every serial device - the app
  verifies it's talking to GRBL by its welcome banner.

## HP-GL cutters (`hpgl` kind)

Vinyl cutters such as the SK-720T speak HP-GL. With a pen holder in place of the blade they plot
like any pen plotter. Two outputs from the same job: download a `.plt` file for the cutter's own
software, or stream it live over Web Serial.

- **Setup on the cutter.** Fit the pen holder and set the blade offset to 0 on the cutter's panel.
  Pens need far less force than a blade - start low.
- **Online, not Leave.** The cutter takes data only from its normal screen (speed and force
  shown). In Leave mode it is offline and ignores the computer.
- **The job starts at the cutter's origin.** Coordinates are absolute from the cutter's own origin,
  and the cutter returns there by itself at the end of every job - so place the artwork on the page
  relative to that corner, and use the fiducial to line the paper up.
- **Orientation.** HP-GL counts up from the origin corner, so the default origin is bottom-left.
  If a test plot comes out mirrored, switch the origin to top-left. Which axis runs along the
  carriage varies by cutter - keep both bed sides within the cut width.
- **Speed and force** go out as `VS` and `FS` at the start of the job. Leave them at 0 to use the
  cutter's panel settings.
- **The cutter reports nothing back.** Progress shows what has been sent, and the pen trails it by
  the cutter's buffer. Pen swaps and the fiducial stop prompt in the app once everything before
  them has been sent - wait until the cutter has stopped moving before you continue. Pausing
  stops sending at the next stroke; stopping a plot sends pen-up and the walk home, which run
  once the cutter has drawn what it already received.
- **Holding still.** Cutters read a gap in the data as the end of the job and drive back to their
  origin. While a plot is paused or waiting at a prompt, the app keeps re-sending the head's
  current position twice a second so it stays put.
- **Go to fiducial.** With the cutter connected, this button moves the head (pen up) to the
  fiducial without plotting and holds it there, so you can check where it lands on the medium and
  line up the paper; *Back to origin* returns it. Plot stays disabled while the head
  is away.
- **Several pens in a downloaded file.** HP-GL has no operator pause; the file selects the next
  pen with `SP`, which multi-pen plotters follow and single-tool cutters ignore. For several colors
  on a cutter, plot live.
- **Connection.** The cutter must show up as a serial port - over USB (usually a CH340 USB-serial
  chip; macOS may need its driver) or a USB-RS232 adapter on its COM port. Some cutters present
  their USB port as a printer instead; Web Serial can't see those, so use the COM port or the
  `.plt` download. Baud rate (default 9600) and flow control (default XON/XOFF) must match the
  cutter's settings, or its buffer overflows mid-job. The cutter sends no greeting, so the app
  can't check what it is talking to - pick the right port.

### Camera registration

A small ESP32-CAM clamped in the tool holder can find three printed registration marks
(Silhouette-style: a square and two L-shaped corners) on a sheet, so the cutter cuts a printed
design in the right place even when the sheet is shifted, rotated, or slightly skewed. It works
with live streaming only.

**Requirements**

- Run Kurvengefahr on `http://localhost`. The HTTPS site cannot load an HTTP camera.
- The camera runs the standard ESP32 `CameraWebServer` firmware; its still-image URL looks like
  `http://<ip>/capture`. VGA resolution is recommended. Focus the lens to the working distance.

**One-time setup** (Machine tab, *Camera registration*)

1. Enter the *Camera URL*.
2. Set the *Soft limit*: the furthest carriage travel with the camera fitted. It applies to camera
   moves and to cut jobs, and only while a camera URL is set.
3. Before the first search, check the carriage direction: *Jog* +Y must move the head left.
4. Put the square mark under the camera and press *Calibrate camera*.
5. Open *Mark layout* if your template differs from the Proxies at Home sheet. *Horizontal
   corner* sets whether the corner mark level with the square lies right or left of it, *Vertical
   corner* whether the other one lies below or above it. Switching a side mirrors the corners
   across the square. Then enter the square's position from the template: it moves all three
   marks. Fine-tune a single corner with its own X and Y.

With a camera URL set, every live HP-GL cut is refused until the sheet is measured. Clear the URL
for plain plotting. Recalibrate after changing the camera resolution.

**Per sheet**

1. Import the template SVG with *Keep original position*, so the artwork sits where the marks
   expect it.
2. Load the printed sheet and press *Measure sheet*. The head searches for the three marks, centers
   on each, and measures it. The first sheet scans the carriage; later sheets start where the marks
   were last time. To start from a different spot, jog onto a mark first.
3. Optional, once after setup: run a *Test cut* (it needs a measured sheet). It cuts a 7.99 mm
   square 1 mm around the square mark. Measure the white rim left around the cut. Knife offset X
   and Y use the jog axes: a positive value shifts the cut the way the *Jog* +X / +Y button moves
   the head. If the rim is wider on one side, shift the cut towards that side by half the
   difference.
4. Swap the camera for the knife at the origin and cut.

Each registration is used by exactly one cut job, so measure again for the next sheet. Test cuts
do not use it up.

**Limits**

- Three marks only: an affine fit. Scale must be within 0.98 to 1.02 and shear within 0.5 degrees.
  You get a warning when a sheet's distortion differs noticeably from the previous sheet's.
- Live streaming only; the `.plt` download is not registered.
- Camera settings are stored per browser, not in the document.
