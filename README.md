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
- **Shift / Ctrl**: Increase / decrease throttle

Configure the start location on the preflight screen before selecting **Start Flight**. The location controls are not available while the simulation is running. Select **End Flight** to return to setup; doing so ends the current flight, and the next start creates a fresh simulation.

The preflight screen defaults to the browser's current local time; you can choose a different initial time of day. A real-time 24-hour day/night cycle starts at that time, with sunrise at 06:00 and sunset at 18:00; sky color, lighting, and terrain fog change through the cycle. Visible sun and moon markers track the aircraft, moonlight illuminates terrain at night, and the sun casts soft terrain shadows during the day.

The simulation advances with the browser animation loop and bounds large frame deltas to keep the flight model stable after pauses or tab switches.
Pitch, roll, and rudder controls have speed-sensitive response and aerodynamic damping. Pitch input applies an aerodynamic moment around the aircraft's rolled lateral axis rather than a fixed rotation rate, with pitch authority reduced at high angles of attack. Lift responds to the angle of attack between aircraft attitude and the flight path, so brief differences between nose attitude and climb or descent are possible during maneuvers. Bank produces sustained turns; rudder introduces a damped sideslip rather than directly steering the flight path. Vertical speed is limited to keep extreme climbs and dives recoverable.

## Airborne Radar

The radar scope searches a 120-degree azimuth sector, a 32-degree elevation volume, and out to 40 nautical miles, using four elevation bars and a 2.4-second scan cycle. A contact is acquired only while the simulated beam overlaps an aircraft in azimuth, elevation, and range, and terrain along the line of sight does not block the return; detections coast for 3.6 seconds between scans. In multiplayer, aircraft with fresh telemetry are supplied to the simulation radar and appear on the heading-up scope with range and relative angles.

## Terrain

The viewport loads public AWS Open Data Terrain Tiles in Mapzen Terrarium format at zoom level 12, along with aligned Sentinel-2 EOxCloudless imagery for the same 12-by-12 tile neighborhood (four times the previous width). Set a start latitude and longitude on the preflight screen; the simulator maps its local `(0, 0)` position to that point. As the aircraft crosses tile boundaries, the browser loads a cached terrain neighborhood, decodes its PNG pixels into meter elevations, and updates the terrain mesh and satellite texture patches. The mesh samples every fourth elevation pixel to keep rendering costs bounded across the larger area, and distance fog fades the far terrain into the sky. Failed terrain requests are reported in the viewport; unavailable imagery falls back to elevation coloring.

The same height grid is copied into WebAssembly once per neighborhood update. Native physics keeps that grid and bilinearly samples it in the flight loop, converting meters to feet for ground contact. Local flight coordinates are treated as a tangent-plane approximation around the chosen origin; this is suitable for the current local flight sector, not long-distance navigation. Terrain data requires network access to the public tile service.

## Peer-to-peer multiplayer

On the preflight screen, choose **Host** and create a separate offer for each joiner. Send each offer using a private out-of-band channel. Each joiner chooses **Join**, pastes their offer, creates an answer, and returns it to the host. Paste each answer into its matching host card and connect the joiners. The host relays each participant's telemetry to all other connected players, so every client sees the other aircraft while maintaining only one P2P connection per joiner. Both players can then start a flight; while connected, each browser sends its flight telemetry over unordered WebRTC data channels. The host controls the shared time of day; connected joiners' time setting is read-only and follows the host during the flight. The host's relay traffic and processing load grow roughly with the square of the number of participants, so practical capacity depends on the host's network and device.

The connection uses Google's public STUN service to discover network addresses. There is no signaling service or TURN relay, so some restrictive NATs or firewalls may prevent a direct connection. Offer and answer strings contain connection metadata; share them only with the intended peer. A working browser WebRTC implementation and a secure context (HTTPS, or localhost) are required.

## Development Workflow

Modifying Flight Dynamics (`sim-core/fm_aircraft.cpp`): Edit aircraft controls or flight-model behavior, then run `./build.ps1` from the root folder to recompile. Terrain behavior belongs in `sim-core/env_terrain.cpp`; radar behavior belongs in `sim-core/ws_radar.cpp`; `sim-core/main.cpp` is the subsystem facade and WebAssembly binding.

Modifying UI/Dashboard (`web-app/app/page.tsx`): Next.js handles hot-reloading for TypeScript/React frontend code automatically. Terrain loading and WebRTC message helpers live in `terrain.ts` and `webrtc.ts`, while the preflight UI and 3D viewport are in `app/components/`.