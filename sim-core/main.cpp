#include <emscripten/bind.h>

#include <algorithm>
#include <cmath>

#include "env_terrain.h"
#include "fm_aircraft.h"
#include "ws_radar.h"

// Coordinates simulation subsystems and exposes the stable WebAssembly API.
class SimEngine {
private:
    Terrain terrain;
    FlightModel aircraft;
    Radar radar;

public:
    // Advances each subsystem using a positive timestep capped at 0.1 seconds.
    void tick(float dt) {
        if (!std::isfinite(dt) || dt <= 0.0f) return;
        dt = std::min(dt, 0.1f);
        aircraft.tick(dt, terrain);
        radar.tick(
            dt,
            aircraft.getPosX(),
            aircraft.getAltitude(),
            aircraft.getPosZ(),
            aircraft.getHeading(),
            aircraft.getPitch(),
            aircraft.getRoll());
    }

    // Forwards normalized flight-control commands to the flight model.
    void setPitchInput(float value) { aircraft.setPitchInput(value); }
    void setRollInput(float value) { aircraft.setRollInput(value); }
    void setYawInput(float value) { aircraft.setYawInput(value); }
    void setThrottle(float value) { aircraft.setThrottle(value); }
    void clearRadarTargets() { radar.clearTargets(); }
    bool addRadarTarget(unsigned int id, float posX, float altitude, float posZ) {
        return radar.addTarget(id, posX, altitude, posZ);
    }

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
    int getRadarContactCount() const { return radar.getContactCount(); }
    unsigned int getRadarContactTargetId(int index) const {
        return radar.getContactTargetId(index);
    }
    float getRadarContactRangeNm(int index) const { return radar.getContactRangeNm(index); }
    float getRadarContactAzimuth(int index) const { return radar.getContactAzimuth(index); }
    float getRadarContactElevation(int index) const { return radar.getContactElevation(index); }
    float getRadarContactAge(int index) const { return radar.getContactAge(index); }
    float getRadarScanAzimuth() const { return radar.getScanAzimuth(); }
    int getRadarScanBar() const { return radar.getScanBar(); }
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
        .function("clearRadarTargets", &SimEngine::clearRadarTargets)
        .function("addRadarTarget", &SimEngine::addRadarTarget)
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
        .function("getCrashed", &SimEngine::getCrashed)
        .function("getRadarContactCount", &SimEngine::getRadarContactCount)
        .function("getRadarContactTargetId", &SimEngine::getRadarContactTargetId)
        .function("getRadarContactRangeNm", &SimEngine::getRadarContactRangeNm)
        .function("getRadarContactAzimuth", &SimEngine::getRadarContactAzimuth)
        .function("getRadarContactElevation", &SimEngine::getRadarContactElevation)
        .function("getRadarContactAge", &SimEngine::getRadarContactAge)
        .function("getRadarScanAzimuth", &SimEngine::getRadarScanAzimuth)
        .function("getRadarScanBar", &SimEngine::getRadarScanBar);
}
