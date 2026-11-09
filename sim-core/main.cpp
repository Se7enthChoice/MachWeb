#include <emscripten/bind.h>

#include <algorithm>
#include <cmath>

#include "env_terrain.h"
#include "fm_aircraft.h"
#include "ws_msl.h"
#include "ws_radar.h"

// Coordinates simulation subsystems and exposes the stable WebAssembly API.
class SimEngine {
private:
    Terrain terrain;
    FlightModel aircraft;
    Radar radar;
    MissileSystem missiles;
    bool radarEnabled = true;

public:
    // Advances each subsystem using a positive timestep capped at 0.1 seconds.
    void tick(float dt) {
        if (!std::isfinite(dt) || dt <= 0.0f) return;
        dt = std::min(dt, 0.1f);
        aircraft.tick(dt, terrain);
        if (radarEnabled) {
            radar.tick(
                dt,
                aircraft.getPosX(),
                aircraft.getAltitude(),
                aircraft.getPosZ(),
                terrain,
                aircraft.getHeading(),
                aircraft.getPitch(),
                aircraft.getRoll());
        }
        missiles.tick(dt, terrain, radar);
    }

    // Forwards normalized flight-control commands to the flight model.
    void setPitchInput(float value) { aircraft.setPitchInput(value); }
    void setRollInput(float value) { aircraft.setRollInput(value); }
    void setYawInput(float value) { aircraft.setYawInput(value); }
    void setThrottle(float value) { aircraft.setThrottle(value); }
    void setRadarEnabled(bool enabled) {
        if (radarEnabled == enabled) return;
        radarEnabled = enabled;
        if (!radarEnabled) radar.reset();
    }
    void clearRadarTargets() { radar.clearTargets(); }
    bool addRadarTarget(unsigned int id, float posX, float altitude, float posZ) {
        if (!radarEnabled) return false;
        return radar.addTarget(id, posX, altitude, posZ);
    }
    void clearMissileTargets() { missiles.clearAircraftTargets(); }
    bool addMissileTarget(unsigned int id, float posX, float altitude, float posZ) {
        return missiles.addAircraftTarget(id, posX, altitude, posZ);
    }
    int launchMissile(unsigned int typeId) {
        return missiles.launch(
            typeId,
            aircraft.getPosX(),
            aircraft.getAltitude(),
            aircraft.getPosZ(),
            aircraft.getAirspeed(),
            aircraft.getHeading(),
            aircraft.getPitch(),
            radar);
    }
    // Applies a confirmed remote missile hit using the aircraft's standard crash timer.
    void applyMissileImpact() { aircraft.applyMissileImpact(); }

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
    int getMissileCount() const { return missiles.getCount(); }
    unsigned int getMissileId(int index) const { return missiles.getId(index); }
    unsigned int getMissileTypeId(int index) const { return missiles.getTypeId(index); }
    unsigned int getMissileTargetId(int index) const { return missiles.getTargetId(index); }
    float getMissilePosX(int index) const { return missiles.getPosX(index); }
    float getMissileAltitude(int index) const { return missiles.getAltitude(index); }
    float getMissilePosZ(int index) const { return missiles.getPosZ(index); }
    float getMissileHeading(int index) const { return missiles.getHeading(index); }
    float getMissilePitch(int index) const { return missiles.getPitch(index); }
    bool getMissileExploded(int index) const { return missiles.getExploded(index); }
    unsigned int getMissileImpactTargetId(int index) const {
        return missiles.getImpactTargetId(index);
    }
    bool getMissileTriggersRwr(int index) const { return missiles.getTriggersRwr(index); }
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
        .function("setRadarEnabled", &SimEngine::setRadarEnabled)
        .function("clearRadarTargets", &SimEngine::clearRadarTargets)
        .function("addRadarTarget", &SimEngine::addRadarTarget)
        .function("clearMissileTargets", &SimEngine::clearMissileTargets)
        .function("addMissileTarget", &SimEngine::addMissileTarget)
        .function("launchMissile", &SimEngine::launchMissile)
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
        .function("getRadarScanBar", &SimEngine::getRadarScanBar)
        .function("getMissileCount", &SimEngine::getMissileCount)
        .function("getMissileId", &SimEngine::getMissileId)
        .function("getMissileTypeId", &SimEngine::getMissileTypeId)
        .function("getMissileTargetId", &SimEngine::getMissileTargetId)
        .function("getMissilePosX", &SimEngine::getMissilePosX)
        .function("getMissileAltitude", &SimEngine::getMissileAltitude)
        .function("getMissilePosZ", &SimEngine::getMissilePosZ)
        .function("getMissileHeading", &SimEngine::getMissileHeading)
        .function("getMissilePitch", &SimEngine::getMissilePitch)
        .function("getMissileExploded", &SimEngine::getMissileExploded)
        .function("getMissileImpactTargetId", &SimEngine::getMissileImpactTargetId)
        .function("applyMissileImpact", &SimEngine::applyMissileImpact)
        .function("getMissileTriggersRwr", &SimEngine::getMissileTriggersRwr);
}
