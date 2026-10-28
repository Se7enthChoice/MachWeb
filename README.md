MachWeb
A browser-native first-person 6DOF flight simulator. Its C++ flight dynamics core is compiled to WebAssembly with Emscripten and drives a Three.js cockpit view and telemetry dashboard.

## Architecture Overview

```text
MachWeb/
├── sim-core/              # C++23 physics simulation core & CMake project
│
│   ├── main.cpp           # Flight dynamics model & Embind bindings
│
│   └── CMakeLists.txt     # Emscripten-compatible CMake config
│
├── web-app/               # Next.js & TypeScript frontend dashboard
│
│   └── public/wasm/       # Compiled Wasm binaries output directory
│
└── build.ps1              # Automated PowerShell build script
```

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
- **A / D**: Roll left / right
- **Q / E**: Yaw left / right
- **Shift / Ctrl**: Increase / decrease throttle
- **L**: Toggle flight assist (auto-level)

The simulation advances with the browser animation loop and bounds large frame deltas to keep the flight model stable after pauses or tab switches.

## Development Workflow
Modifying Physics (`sim-core/main.cpp`): Edit your C++ simulation logic, then run `./build.ps1` from the root folder to recompile. Refresh your browser to see the updates instantly.

Modifying UI/Dashboard (`web-app/app/page.tsx`): Next.js handles hot-reloading for all TypeScript/React frontend code automatically.