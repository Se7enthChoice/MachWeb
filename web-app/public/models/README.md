# Missile models

The AMRAAM and ASRAAM visuals are converted from AC3D models in the
[FGUK-weapons package](https://github.com/FGMEMBERS/FGUK-weapons/tree/25f578ca4b3844e362dff4b150aa371899aca16e),
licensed under GPL-2.0. The package's license is included at `source/COPYING`.

- `aim-120.glb`: AMRAAM, converted from `source/AIM-120.ac` and its texture.
- `aim-132.glb`: ASRAAM, converted from `source/AIM-132.ac`.

The original model sources are retained under `source/`. The GLB conversions
center and scale the meshes, orient them along the simulator's forward axis,
and package their materials for Three.js.
