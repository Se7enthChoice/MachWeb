#pragma once

#include "env_terrain.h"
#include "utils.h"

class FlightModel {
private:
    float posX = 0.0f;
    float altitude = 5000.0f;
    float posZ = 0.0f;
    float velocityX = 0.0f;
    float velocityY = 0.0f;
    float velocityZ = -300.0f * KTs_to_FPS;
    float windX = 0.0f;
    float windZ = 0.0f;
    float airspeed = 300.0f;
    float throttle = 0.43f;
    float crashTimeRemaining = 0.0f;
    bool onGround = false;
    // Gear starts down; retracted gear removes the normal wheel-clearance allowance.
    bool landingGearDown = true;
    // Keeps terrain alignment from cancelling a pilot-requested takeoff rotation.
    bool gearRotationRequested = false;

    float pitchAngle = 0.0f;
    float rollAngle = 0.0f;
    float heading = 0.0f;
    float pitchRate = 0.0f;
    float rollRate = 0.0f;
    float yawRate = 0.0f;
    float verticalSpeed = 0.0f;

    float pitchInput = 0.0f;
    float rollInput = 0.0f;
    float yawInput = 0.0f;
    bool brakeInput = false;

public:
    void setInitialConditions(float initialAltitude, float initialHeading);

    // Applies the standard three-second damage/crash indication.
    void applyMissileImpact() {
        crashTimeRemaining = std::max(crashTimeRemaining, crashed_duration);
    }
    void tick(float dt, const Terrain& terrain);

    void setPitchInput(float value);
    void setRollInput(float value);
    void setYawInput(float value);
    void setThrottle(float value);
    // Changes terrain-contact mode and clears the previous ground/rotation latch as needed.
    void setLandingGearDown(bool down);
    // Wheel braking is applied only during gear-down ground contact.
    void setBrakeInput(bool braking);
    void setWind(float eastKnots, float northKnots);

    float getPosX() const { return posX; }
    float getAltitude() const { return altitude; }
    float getPosZ() const { return posZ; }
    float getAirspeed() const { return airspeed; }
    float getThrottle() const { return throttle * 100.0f; }
    float getPitch() const { return pitchAngle; }
    float getRoll() const { return rollAngle; }
    float getHeading() const { return heading; }
    float getVerticalSpeed() const { return verticalSpeed; }
    // Reports wheel-supported ground contact, not a gear-up fuselage impact.
    bool getOnGround() const { return onGround && landingGearDown; }
    bool getCrashed() const { return crashTimeRemaining > 0.0f; }
};
