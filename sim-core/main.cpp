#include <emscripten/bind.h>

#include <algorithm>
#include <cmath>

#include "env_terrain.h"
#include "fm_aircraft.h"
#include "ws_systems.h"

// Coordinates simulation subsystems and exposes the stable WebAssembly API.
class SimEngine {
private:
    Terrain terrain;
    FlightModel aircraft;
    WeaponSystems weapons;

public:
    // Advances each subsystem using a positive timestep capped at 0.1 seconds.
    void tick(float dt) {
        if (!std::isfinite(dt) || dt <= 0.0f) return;
        dt = std::min(dt, 0.1f);
        aircraft.tick(dt, terrain);
        weapons.tick(dt);
    }

    // Forwards normalized flight-control commands to the flight model.
    void setPitchInput(float value) { aircraft.setPitchInput(value); }
    void setRollInput(float value) { aircraft.setRollInput(value); }
    void setYawInput(float value) { aircraft.setYawInput(value); }
    void setThrottle(float value) { aircraft.setThrottle(value); }

    // Replaces terrain data; returns false when the supplied grid is invalid.
    bool setTerrainData(
        unsigned int dataPointer,
        int width,
        int height,
        float spacingXFeet,
        float spacingZFeet,
        float originXFeet,
        float originZFeet) {
        return terrain.setData(
            dataPointer,
            width,
            height,
            spacingXFeet,
            spacingZFeet,
            originXFeet,
            originZFeet);
    }

    // Removes the active terrain heightmap.
    void clearTerrainData() { terrain.clear(); }

    // Returns the aircraft state through the existing WebAssembly API.
    float getPosX() const { return aircraft.getPosX(); }
    float getAltitude() const { return aircraft.getAltitude(); }
    float getPosZ() const { return aircraft.getPosZ(); }

    // Returns terrain elevation at the aircraft's current horizontal position.
    float getGroundElevation() const {
        return terrain.getElevationFeet(aircraft.getPosX(), aircraft.getPosZ());
    }
    float getAirspeed() const { return aircraft.getAirspeed(); }
    float getThrottle() const { return aircraft.getThrottle(); }
    float getPitch() const { return aircraft.getPitch(); }
    float getRoll() const { return aircraft.getRoll(); }
    float getHeading() const { return aircraft.getHeading(); }
    float getVerticalSpeed() const { return aircraft.getVerticalSpeed(); }
    bool getCrashed() const { return aircraft.getCrashed(); }
};

// Binds the simulation facade methods used by the web application.
EMSCRIPTEN_BINDINGS(sim_engine) {
    emscripten::class_<SimEngine>("SimEngine")
        .constructor<>()
        .function("tick", &SimEngine::tick)
        .function("setPitchInput", &SimEngine::setPitchInput)
        .function("setRollInput", &SimEngine::setRollInput)
        .function("setYawInput", &SimEngine::setYawInput)
        .function("setThrottle", &SimEngine::setThrottle)
        .function("setTerrainData", &SimEngine::setTerrainData)
        .function("clearTerrainData", &SimEngine::clearTerrainData)
        .function("getPosX", &SimEngine::getPosX)
        .function("getAltitude", &SimEngine::getAltitude)
        .function("getPosZ", &SimEngine::getPosZ)
        .function("getGroundElevation", &SimEngine::getGroundElevation)
        .function("getAirspeed", &SimEngine::getAirspeed)
        .function("getThrottle", &SimEngine::getThrottle)
        .function("getPitch", &SimEngine::getPitch)
        .function("getRoll", &SimEngine::getRoll)
        .function("getHeading", &SimEngine::getHeading)
        .function("getVerticalSpeed", &SimEngine::getVerticalSpeed)
        .function("getCrashed", &SimEngine::getCrashed);
}
