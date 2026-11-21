MachWeb
A browser-native first-person 6DOF flight simulator. Its C++ flight dynamics core is compiled to WebAssembly with Emscripten and drives a Three.js cockpit view and telemetry dashboard.

## Architecture Overview

```text
MachWeb/
├── sim-core/                         # C++23 simulation core compiled to WebAssembly
│   ├── main.cpp                      # SimEngine facade and Embind API exposed to JavaScript
│   ├── env_terrain.cpp               # Terrain heightmap validation, caching, and sampling
│   ├── env_terrain.h                 # Terrain subsystem interface and grid state
│   ├── fm_aircraft.cpp               # Aircraft state updates, controls, and flight dynamics
│   ├── fm_aircraft.h                 # Flight model interface and aircraft state
│   ├── ws_radar.cpp                  # Scanning airborne radar and contact tracking
│   ├── ws_radar.h                    # Radar subsystem interface
│   ├── ws_msl.cpp                    # Missile guidance, flight, range, and impact
│   ├── ws_msl.h                      # Extensible missile type and simulation interfaces
│   ├── utils.h                       # Shared constants and vector/angle math helpers
│   ├── CMakeLists.txt                # CMake target and Emscripten linker configuration
│   └── build/                        # Generated CMake/Ninja output (created by the build)
├── web-app/                          # Next.js, React, and TypeScript frontend
│   ├── app/
│   │   ├── page.tsx                  # Preflight, simulation lifecycle, WASM and multiplayer coordination
│   │   ├── terrain.ts                # Geographic conversion and terrain/imagery tile loading
│   │   ├── webrtc.ts                 # Signaling-description encoding and multiplayer message validation
│   │   ├── layout.tsx                # Root document layout, fonts, and metadata
│   │   ├── globals.css               # Global styles and Tailwind CSS entry point
│   │   ├── favicon.ico               # Application favicon
│   │   └── components/
│   │       ├── PreflightScreen.tsx   # Flight setup and multiplayer connection UI
│   │       ├── FlightViewport.tsx    # Three.js cockpit view, terrain, lighting, and remote aircraft
│   │       └── RadarScope.tsx        # Heading-up radar scope overlay
│   ├── public/wasm/
│   │   ├── sim-core.js               # Generated Emscripten JavaScript loader
│   │   └── sim-core.wasm             # Generated WebAssembly simulation binary
│   ├── package.json                  # Frontend dependencies and development scripts
│   ├── package-lock.json             # Locked npm dependency versions
│   ├── next.config.ts                # Next.js configuration
│   ├── eslint.config.mjs             # ESLint configuration
│   ├── tsconfig.json                 # TypeScript configuration
│   ├── next-env.d.ts                 # Next.js TypeScript environment declarations
│   └── AGENTS.md                     # Next.js-generated guidance for coding agents
└── build.ps1                         # Builds the Wasm core and copies artifacts into web-app/public/wasm
```

The C++ core is divided by subsystem prefix: `env_` for environmental data, `fm_` for flight
model and controls, and `ws_` for weapon systems such as the radar. `main.cpp` coordinates these
modules and preserves the JavaScript-facing `SimEngine` API. The frontend loads the compiled core, supplies
terrain and control inputs, and renders local and multiplayer flight state.

## Prerequisites
Before setting up the repository on a fresh Windows machine, ensure you have the following installed:

Git (for cloning the repository)

Node.js (LTS) (includes npm)

CMake (v3.20 or newer)

Ninja Build Tool (fast build system required by Emscripten)

Install easily via PowerShell:

```powershell
winget install Ninja-build.Ninja
```

Emscripten SDK (EMSDK)

Typically cloned as a sibling directory to your project workspace (e.g., `C:\Users\<username>\source\repos\web\emsdk`).

## Getting Started & Setup
1. Clone the Repository

```powershell
git clone https://github.com/YOUR_USERNAME/MachWeb.git
cd MachWeb
```

2. Set Up the Emscripten SDK (EMSDK)
If you haven't set up Emscripten on this machine yet, navigate to your parent tools directory and install it:

```powershell
# Example setup in a sibling folder
cd ..
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
cd ../MachWeb
```

(Note: Verify that the path to `emsdk_env.ps1` matches what is configured at the top of your `build.ps1` script.)

3. Install Frontend Dependencies
Navigate into the Next.js application folder and install dependencies:

```powershell
cd web-app
npm install
cd ..
```

## Building the Simulation Core
The project uses an automated PowerShell script (build.ps1) to handle the entire C++ compilation pipeline: it activates EMSDK, configures CMake with the Ninja generator, compiles sim-core to WebAssembly, and copies the resulting .js and .wasm artifacts directly into Next.js's public/wasm/ folder.

If script execution is restricted on a fresh PowerShell session, allow local scripts first:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
```

Run the build script from the root directory:

```powershell
./build.ps1
```

## Running the Development Server
Once the build artifacts are generated in web-app/public/wasm/:

Navigate to the web app directory:

```powershell
cd web-app
```

Start the Next.js development server:

```powershell
npm run dev
```

Open your browser and navigate to http://localhost:3000.

## Flight Controls

- **W / S**: Pitch up / down
- **A / D**: Bank for turns
- **Q / E**: Rudder yaw / sideslip
- **G**: Toggle landing gear
- **Shift / Ctrl**: Increase throttle / decrease throttle in flight, brake on the ground
- **N**: Cycle active radar tracks and set the primary target
- **1 / 2 / 3** (top number row): Select gun / IR ASRAAM / radar AMRAAM
- **8 / 9** (top number row): Select chaff / flares
- **Enter**: Fire or deploy the selected weapon; hold to keep firing the gun or dispensing countermeasures
- **`**: Deselect the current weapon

Configure the start location, altitude (0–60,000 ft MSL), and heading (0–359°) on the preflight screen before selecting **Start Flight**. The default altitude is 5,000 ft and the default heading is north (0°). These controls are not available while the simulation is running. Select **End Flight** to return to setup; doing so ends the current flight, and the next start creates a fresh simulation.

The preflight screen defaults to the browser's current local time; you can choose a different initial time of day. Solo pilots and multiplayer hosts can optionally enter their own FlyItalyADSB API key to fetch nearby live traffic. The browser polls within 100 km every 2 seconds, matching the Free plan's 30-requests-per-minute limit; the Free plan also allows 300,000 requests per month. ADS-B aircraft are interpolated and smoothed between those updates. In multiplayer, only the host fetches and relays compact position snapshots to joiners over the existing WebRTC data channel. The API key remains in page memory by default. An opt-in preflight setting stores it in session storage for the current tab session, including across reloads; browser storage is accessible to scripts running on the site, so avoid enabling it on shared or untrusted devices. The key is sent only to FlyItalyADSB, never to peers. ADS-B contacts appear as blue 3D aircraft and radar returns, and the viewport displays the required attribution when contacts are present: “Flight data: FlyItalyADSB (flyitalyadsb.com), CC BY-SA 4.0”.

A real-time 24-hour day/night cycle starts at the selected time, with sunrise at 06:00 and sunset at 18:00; sky color, lighting, and terrain fog change through the cycle. Visible sun and moon markers track the aircraft, moonlight illuminates terrain at night, and the sun casts soft terrain shadows during the day.

Preflight weather offers **SUN**, **RAIN**, **SNOW**, **LIGHTNING STORM**, and **REAL**, with REAL selected by default. In multiplayer, the host selects the shared preset and joiners receive it; REAL conditions are still fetched locally for each aircraft. Open-Meteo is queried at the aircraft's current coordinates immediately and every minute, outside peer telemetry. Its update status appears below the **END FLIGHT** button. Wind changes the aircraft's ground track while the flight model continues to use air-relative velocity for aerodynamic forces. Clouds are rendered as world-anchored volumes using a custom GLSL ray marcher over a generated 3D Perlin-Worley noise texture; precipitation particle density scales with the reported precipitation rate, snow uses drifting flakes, and storm flashes and visibility-based fog are rendered in the Three.js world.

The simulation advances with the browser animation loop and bounds large frame deltas to keep the flight model stable after pauses or tab switches.
Pitch, roll, and rudder controls have speed-sensitive response and aerodynamic damping. Pitch input applies an aerodynamic moment around the aircraft's rolled lateral axis rather than a fixed rotation rate, with pitch authority reduced at high angles of attack. Lift responds to the angle of attack between aircraft attitude and the flight path, so brief differences between nose attitude and climb or descent are possible during maneuvers. Bank produces sustained turns; rudder introduces a damped sideslip rather than directly steering the flight path. Vertical speed is limited to keep extreme climbs and dives recoverable. Landing gear start up; when down, they provide 15 ft of terrain clearance, conform roll to the local slope, and absorb touchdowns below the safe sink-rate threshold. Pressing **G** toggles the gear. Pilot pitch input is never overwritten during takeoff rotation, and the camera retains an independent terrain-clearance guard.

## Airborne Radar

The radar scope searches a 120-degree azimuth sector, a 32-degree elevation volume, and out to 40 nautical miles, using four elevation bars and a 2.4-second scan cycle. A contact is acquired only while the simulated beam overlaps an aircraft in azimuth, elevation, and range, and terrain along the line of sight does not block the return; detections coast for 3.6 seconds between scans. In multiplayer, aircraft with fresh telemetry and host-relayed ADS-B contacts are supplied to the simulation radar and appear on the heading-up scope with range and relative angles. Press **N** to cycle active contacts nearest-first and mark the primary target; ADS-B returns are passive guidance contacts and do not register missile impacts.

The bearing-only radar warning receiver appears alongside the radar scope only when a multiplayer peer's radar has detected the local aircraft. Detected player IDs travel with peer telemetry, and threat spokes show the emitters' relative bearings; alerts clear when detections coast out or telemetry becomes stale.

## Missiles

The lower-right viewport HUD shows the selected weapon and its remaining inventory. Select **1** for the gun, **2** for IR ASRAAMs, **3** for radar AMRAAMs, **8** for chaff, or **9** for flares (use the top number row, not the keypad). Press the **Backquote key** (`) to deselect. **Enter** fires or deploys the selected weapon; missiles fire once per press, while holding Enter repeats gunfire or countermeasure deployment. No weapon is selected by default.

The gun starts with 150 rounds, fires at 600 RPM, and has a 1-nautical-mile raycast range. Change its fire rate in `sim-core/ws_gun.h`. The aircraft carries four ASRAAMs and four AMRAAMs; both can follow a selected primary radar track within their range, or launch unguided when no track is selected. The radar AMRAAM reaches 900 knots, turns at up to 25 degrees per second and 20 g, and has a 10-nautical-mile range and 50-second fuse. The infrared ASRAAM reaches 1,100 knots, turns at up to 45 degrees per second and 30 g, and has an 8-nautical-mile range and 35-second fuse; it does not trigger the radar warning receiver.

The aircraft carries 24 chaff bundles and 12 flares. Chaff dispenses every 0.35 seconds and flares every 0.5 seconds while Enter is held. Decoys eject behind the aircraft, inherit its motion, drift and fall, and lose effectiveness as they disperse or burn out (8 seconds for chaff, 4 seconds for flares). Seeker field of view, range, decoy type, and fading signature affect whether a missile is seduced; decoys are not guaranteed to defeat a missile. Flares render as hot, bright embers and cast a warm point light whose illumination is strongest at night and subdued in daylight. Countermeasure state is included in multiplayer telemetry so peers' missiles and visuals use the same decoy positions. Missile impacts, terrain strikes, and proximity fuses still apply normally.

Missiles explode on aircraft or terrain impact, at maximum range, or when their flight-time fuse expires. Aircraft hit within the missile's 200-foot impact radius show **CRASHED** for three seconds. Missile state and impact events are included in relayed telemetry so every multiplayer client renders the same launches and impacts. The missile type configuration includes range, speed, lifetime, seeker, turn, and RWR-warning settings for adding other weapons later.

Incoming generic missiles targeting the local aircraft appear as threat bearings on the radar warning receiver. Missile telemetry is validated and bounded before it is relayed to other peers. Remote missile models use a 50 ms interpolation buffer, motion extrapolation capped at 200 ms for delayed snapshots, and frame-rate-independent visual smoothing with a 35 ms time constant.

## Terrain

The viewport loads public AWS Open Data Terrain Tiles in Mapzen Terrarium format at zoom level 12, along with aligned Sentinel-2 EOxCloudless imagery for the same 12-by-12 tile neighborhood (four times the previous width). Set a start latitude and longitude on the preflight screen; the simulator maps its local `(0, 0)` position to that point. As the aircraft crosses tile boundaries, the browser loads a cached terrain neighborhood, decodes its PNG pixels into meter elevations, and updates the terrain mesh and satellite texture patches. The mesh samples every fourth elevation pixel to keep rendering costs bounded across the larger area, and distance fog fades the far terrain into the sky. Failed terrain requests are reported in the viewport; unavailable imagery falls back to elevation coloring.

The same height grid is copied into WebAssembly once per neighborhood update. Native physics keeps that grid and bilinearly samples it in the flight loop, converting meters to feet for ground contact. Local flight coordinates are treated as a tangent-plane approximation around the chosen origin; this is suitable for the current local flight sector, not long-distance navigation. Terrain data requires network access to the public tile service.

## Peer-to-peer multiplayer

On the preflight screen, choose **Host** and create a separate offer for each joiner. Send each offer using a private out-of-band channel. Each joiner chooses **Join**, pastes their offer, creates an answer, and returns it to the host. Paste each answer into its matching host card and connect the joiners. The host relays each participant's telemetry to all other connected players, so every client sees the other aircraft while maintaining only one P2P connection per joiner. Both players can then start a flight; while connected, each browser sends flight telemetry at 30 Hz over unordered WebRTC data channels with retransmissions disabled. Remote aircraft are rendered from a buffer of received snapshots. Each snapshot carries the sender's sample time and is stamped with its true arrival time as soon as it is received, outside React's render cycle. Receivers map sender time onto their own clock using the fastest recent packets, so bursty or late delivery does not distort the spacing between samples; the interpolation delay adapts to measured queuing and changes gradually, and aircraft briefly dead-reckon (up to 120 ms) if packets run late. The local camera is driven directly from the simulator each frame, and remote playback is evaluated on the same simulator clock, so the apparent offset between aircraft stays steady at high speed. To keep state current, snapshots are skipped when a channel's buffered data exceeds 16 KiB. The host controls the shared time of day; the time-of-day and weather controls are hidden for joiners, who follow the host's settings during the flight. The host's relay traffic and processing load grow roughly with the square of the number of participants, so practical capacity depends on the host's network and device.

The connection uses Google's public STUN service to discover network addresses. There is no signaling service or TURN relay, so some restrictive NATs or firewalls may prevent a direct connection. Offer and answer strings contain connection metadata; share them only with the intended peer. A working browser WebRTC implementation and a secure context (HTTPS, or localhost) are required.

## Development Workflow

Modifying Flight Dynamics (`sim-core/fm_aircraft.cpp`): Edit aircraft controls or flight-model behavior, then run `./build.ps1` from the root folder to recompile. Terrain behavior belongs in `sim-core/env_terrain.cpp`; radar behavior belongs in `sim-core/ws_radar.cpp`; `sim-core/main.cpp` is the subsystem facade and WebAssembly binding.

Modifying UI/Dashboard (`web-app/app/page.tsx`): Next.js handles hot-reloading for TypeScript/React frontend code automatically. Terrain loading and WebRTC message helpers live in `terrain.ts` and `webrtc.ts`, while the preflight UI and 3D viewport are in `app/components/`.