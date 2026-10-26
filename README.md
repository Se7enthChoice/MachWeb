MachWeb
A high-performance, browser-native tactical flight simulation engine. Built with a C++23 physics core compiled to WebAssembly via Emscripten, integrated with a Next.js & React telemetry dashboard running at a deterministic 60Hz.

🏗️ Architecture Overview
Plaintext
MachWeb/
├── sim-core/              # C++23 physics simulation core & CMake project
│   ├── src/main.cpp       # Flight dynamics model & Embind bindings
│   └── CMakeLists.txt     # Emscripten-compatible CMake config
├── web-app/               # Next.js & TypeScript frontend dashboard
│   └── public/wasm/       # Compiled Wasm binaries output directory
└── build.ps1              # Automated PowerShell build script

⚙️ Prerequisites
Before setting up the repository on a fresh Windows machine, ensure you have the following installed:

Git (for cloning the repository)

Node.js (LTS) (includes npm)

CMake (v3.20 or newer)

Ninja Build Tool (fast build system required by Emscripten)

Install easily via PowerShell:

PowerShell
winget install Ninja-build.Ninja
Emscripten SDK (EMSDK)

Typically cloned as a sibling directory to your project workspace (e.g., C:\Users\<username>\source\repos\web\emsdk).

🚀 Getting Started & Setup
1. Clone the Repository
PowerShell
git clone https://github.com/YOUR_USERNAME/aether-vector.git
cd aether-vector
2. Set Up the Emscripten SDK (EMSDK)
If you haven't set up Emscripten on this machine yet, navigate to your parent tools directory and install it:

PowerShell
# Example setup in a sibling folder
cd ..
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
cd ../aether-vector
(Note: Verify that the path to emsdk_env.ps1 matches what is configured at the top of your build.ps1 script).

3. Install Frontend Dependencies
Navigate into the Next.js application folder and install dependencies:

PowerShell
cd web-app
npm install
cd ..
🔨 Building the Simulation Core
The project uses an automated PowerShell script (build.ps1) to handle the entire C++ compilation pipeline: it activates EMSDK, configures CMake with the Ninja generator, compiles sim-core to WebAssembly, and copies the resulting .js and .wasm artifacts directly into Next.js's public/wasm/ folder.

If script execution is restricted on a fresh PowerShell session, allow local scripts first:

PowerShell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
Run the build script from the root directory:

PowerShell
./build.ps1

Running the Development Server
Once the build artifacts are generated in web-app/public/wasm/:

Navigate to the web app directory:

PowerShell
cd web-app
Start the Next.js development server:

PowerShell
npm run dev
Open your browser and navigate to http://localhost:3000.

Development Workflow
Modifying Physics (sim-core/src/main.cpp): Edit your C++ simulation logic, then run ./build.ps1 from the root folder to recompile. Refresh your browser to see the updates instantly.

Modifying UI/Dashboard (web-app/src/app/page.tsx): Next.js handles hot-reloading for all TypeScript/React frontend code automatically.