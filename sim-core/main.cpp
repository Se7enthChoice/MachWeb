#include <emscripten/bind.h>
#include <emscripten/emscripten.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

#include "utils.h"

class SimEngine {
private:
    float posX = 0.0f;
    float altitude = 5000.0f; // Feet
    float posZ = 0.0f;
    float velocityX = 0.0f;
    float velocityY = 0.0f;
    float velocityZ = -300.0f * KTs_to_FPS;
    float airspeed = 300.0f;
    float throttle = 0.43f;
    float crashTimeRemaining = 0.0f;
    bool onGround = false;
    std::vector<float> terrainHeightsMeters;
    int terrainWidth = 0;
    int terrainHeight = 0;
    float terrainSpacingXFeet = 0.0f;
    float terrainSpacingZFeet = 0.0f;
    float terrainOriginXFeet = 0.0f;
    float terrainOriginZFeet = 0.0f;

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

    // Gets the orientation basis vectors (forward, up, right) based on the current heading, pitch, and roll angles.
    static void getOrientationBasis(
        float headingDegrees,
        float pitchDegrees,
        float rollDegrees,
        Vector3& forward,
        Vector3& up,
        Vector3& right) 
        {
        const float pitch = pitchDegrees * DEG_to_RAD;
        const float roll = rollDegrees * DEG_to_RAD;
        const float heading = headingDegrees * DEG_to_RAD;
        const float sinPitch = std::sin(pitch);
        const float cosPitch = std::cos(pitch);
        const float sinRoll = std::sin(roll);
        const float cosRoll = std::cos(roll);
        const float sinHeading = std::sin(heading);
        const float cosHeading = std::cos(heading);

        forward = {sinHeading * cosPitch, sinPitch, -cosHeading * cosPitch};
        up = {
            -sinHeading * sinPitch * cosRoll + cosHeading * sinRoll,
            cosPitch * cosRoll,
            cosHeading * sinPitch * cosRoll + sinHeading * sinRoll,
        };
        right = {
            cosHeading * cosRoll + sinHeading * sinPitch * sinRoll,
            -cosPitch * sinRoll,
            sinHeading * cosRoll - cosHeading * sinPitch * sinRoll,
        };
    }

    // Samples the terrain height in meters at the specified (xFeet, zFeet) position using bilinear interpolation.
    float sampleTerrainMeters(float xFeet, float zFeet) const {
        if (terrainHeightsMeters.empty()) return 0.0f;

        const float gridX = (xFeet - terrainOriginXFeet) / terrainSpacingXFeet;
        const float gridZ = (zFeet - terrainOriginZFeet) / terrainSpacingZFeet;
        if (!std::isfinite(gridX) || !std::isfinite(gridZ) ||
            gridX < 0.0f || gridZ < 0.0f ||
            gridX > terrainWidth - 1 || gridZ > terrainHeight - 1) {
            return 0.0f;
        }

        // Interpolate the four neighboring raster samples for smooth contact heights.
        const int x0 = static_cast<int>(gridX);
        const int z0 = static_cast<int>(gridZ);
        const int x1 = std::min(x0 + 1, terrainWidth - 1);
        const int z1 = std::min(z0 + 1, terrainHeight - 1);
        const float fractionX = gridX - x0;
        const float fractionZ = gridZ - z0;
        const float northWest = terrainHeightsMeters[z0 * terrainWidth + x0];
        const float northEast = terrainHeightsMeters[z0 * terrainWidth + x1];
        const float southWest = terrainHeightsMeters[z1 * terrainWidth + x0];
        const float southEast = terrainHeightsMeters[z1 * terrainWidth + x1];
        const float north = northWest + (northEast - northWest) * fractionX;
        const float south = southWest + (southEast - southWest) * fractionX;
        return north + (south - north) * fractionZ;
    }

public:
    // The main simulation tick function, which updates the aircraft's state based on the elapsed time (dt).
    void tick(float dt) {
        if (!std::isfinite(dt) || dt <= 0.0f) return;
        dt = std::min(dt, 0.1f);
        crashTimeRemaining = std::max(0.0f, crashTimeRemaining - dt);

        float speedFeetPerSecond = std::sqrt(
            velocityX * velocityX + velocityY * velocityY + velocityZ * velocityZ);
        if (!std::isfinite(speedFeetPerSecond)) {
            velocityX = 0.0f;
            velocityY = 0.0f;
            velocityZ = -300.0f * KTs_to_FPS;
            speedFeetPerSecond = 300.0f * KTs_to_FPS;
        }
        airspeed = clamp_finite(speedFeetPerSecond / KTs_to_FPS, 0.0f, max_airspeed);

        const float rollRad = rollAngle * DEG_to_RAD;
        const float sinRoll = std::sin(rollRad);
        const float cosRoll = std::cos(rollRad);
        const float headingRad = heading * DEG_to_RAD;
        const float sinHeading = std::sin(headingRad);
        const float cosHeading = std::cos(headingRad);

        Vector3 forward;
        Vector3 up;
        Vector3 right;
        getOrientationBasis(heading, pitchAngle, rollAngle, forward, up, right);
        const Vector3 velocity{velocityX, velocityY, velocityZ};
        const float angleOfAttack = std::atan2(-dot(velocity, up), dot(velocity, forward));
        const float angleOfAttackDegrees = angleOfAttack * RAD_to_DEG;
        const float pitchDynamicPressure = std::pow(
            std::clamp(airspeed / cruise_airspeed, 0.0f, 1.35f), 2.0f);
        const float controlAuthority = std::clamp(airspeed / cruise_airspeed, 0.35f, 1.35f);
        const float maxRollRate = 100.0f * controlAuthority;
        const float maxYawRate = 10.0f * controlAuthority;
        float targetRollRate = rollInput * maxRollRate;
        const float targetYawRate = yawInput * maxYawRate;

        const float highAngleOfAttack = std::max(std::abs(angleOfAttackDegrees) - 12.0f, 0.0f);
        const float elevatorEffectiveness = std::clamp(
            1.0f - highAngleOfAttack / 24.0f, 0.15f, 1.0f);
        const float pitchAcceleration =
            pitchInput * 120.0f * pitchDynamicPressure * elevatorEffectiveness;
        float aerodynamicPitchingMoment =
            -angleOfAttackDegrees * 0.12f * pitchDynamicPressure;
        if (pitchInput * aerodynamicPitchingMoment > 0.0f) {
            aerodynamicPitchingMoment = 0.0f;
        }
        pitchRate += (pitchAcceleration + aerodynamicPitchingMoment -
            pitchRate * (1.5f + pitchDynamicPressure)) * dt;
        rollRate += (targetRollRate - rollRate) * std::min(5.0f * dt, 1.0f);
        yawRate += (targetYawRate - yawRate) * std::min(4.0f * dt, 1.0f);

        const float speedX = velocityX / std::max(speedFeetPerSecond, 1.0f);
        const float speedY = velocityY / std::max(speedFeetPerSecond, 1.0f);
        const float speedZ = velocityZ / std::max(speedFeetPerSecond, 1.0f);
        const float upAlongVelocity = up.x * speedX + up.y * speedY + up.z * speedZ;
        float liftX = up.x - upAlongVelocity * speedX;
        float liftY = up.y - upAlongVelocity * speedY;
        float liftZ = up.z - upAlongVelocity * speedZ;
        float liftDirectionLength = std::sqrt(liftX * liftX + liftY * liftY + liftZ * liftZ);
        if (liftDirectionLength < 0.001f) {
            liftX = cosHeading;
            liftY = 0.0f;
            liftZ = sinHeading;
            liftDirectionLength = 1.0f;
        }
        liftX /= liftDirectionLength;
        liftY /= liftDirectionLength;
        liftZ /= liftDirectionLength;

        const float liftFactor = airspeed / cruise_airspeed;
        const float liftCoefficient = std::clamp(
            1.0f + angleOfAttack / (12.0f * DEG_to_RAD), -1.0f, 3.0f);
        const float lift = std::clamp(
            gravity * liftFactor * liftFactor * liftCoefficient /
                std::max(std::abs(cosRoll), 0.2f),
            -gravity * 7.0f,
            gravity * 7.0f);
        const float bankedTurnRate = RAD_to_DEG * lift * sinRoll /
            std::max(speedFeetPerSecond, 50.0f);

        const float thrustAcceleration = throttle * 42.0f;
        const float dragAcceleration = speedFeetPerSecond * 0.03f;
        const float lateralVelocity = dot(velocity, right);
        const float lateralAcceleration = -lateralVelocity * 2.5f;

        velocityX += (forward.x * thrustAcceleration + liftX * lift -
            speedX * dragAcceleration + right.x * lateralAcceleration) * dt;
        velocityY += (forward.y * thrustAcceleration + liftY * lift -
            speedY * dragAcceleration + right.y * lateralAcceleration - gravity) * dt;
        velocityZ += (forward.z * thrustAcceleration + liftZ * lift -
            speedZ * dragAcceleration + right.z * lateralAcceleration) * dt;

        velocityY = clamp_finite(
            velocityY,
            -max_vertical_speed / 60.0f,
            max_vertical_speed / 60.0f);
        speedFeetPerSecond = std::sqrt(
            velocityX * velocityX + velocityY * velocityY + velocityZ * velocityZ);
        const float maxSpeedFeetPerSecond = max_airspeed * KTs_to_FPS;
        if (speedFeetPerSecond > maxSpeedFeetPerSecond) {
            const float scale = maxSpeedFeetPerSecond / speedFeetPerSecond;
            velocityX *= scale;
            velocityY *= scale;
            velocityZ *= scale;
        }

        posX += velocityX * dt;
        altitude += velocityY * dt;
        posZ += velocityZ * dt;
        verticalSpeed = velocityY * 60.0f;

        posX = clamp_finite(posX, -100000000.0f, 100000000.0f);
        posZ = clamp_finite(posZ, -100000000.0f, 100000000.0f);
        altitude = clamp_finite(altitude, -1000000.0f, 1000000.0f);
        airspeed = clamp_finite(
            std::sqrt(velocityX * velocityX + velocityY * velocityY + velocityZ * velocityZ) /
                KTs_to_FPS,
            0.0f,
            max_airspeed);

        const float pitchDelta = pitchRate * dt * DEG_to_RAD;
        forward = rotate_around_axis(forward, right, pitchDelta);
        up = rotate_around_axis(up, right, pitchDelta);

        const float rollDelta = rollRate * dt * DEG_to_RAD;
        up = rotate_around_axis(up, forward, rollDelta);
        right = rotate_around_axis(right, forward, rollDelta);

        const float yawDelta = -yawRate * dt * DEG_to_RAD;
        forward = rotate_around_axis(forward, up, yawDelta);
        right = rotate_around_axis(right, up, yawDelta);

        const Vector3 worldDown{0.0f, -1.0f, 0.0f};
        const float bankTurnDelta = bankedTurnRate * dt * DEG_to_RAD;
        forward = rotate_around_axis(forward, worldDown, bankTurnDelta);
        up = rotate_around_axis(up, worldDown, bankTurnDelta);
        right = rotate_around_axis(right, worldDown, bankTurnDelta);

        forward = normalized(forward);
        right = normalized(cross(forward, up));
        up = normalized(cross(right, forward));
        const float principalPitch = std::asin(std::clamp(forward.y, -1.0f, 1.0f)) *
            RAD_to_DEG;
        const float invertedPitch = principalPitch >= 0.0f
            ? 180.0f - principalPitch
            : -180.0f - principalPitch;
        const bool useInvertedPitch =
            std::abs(wrap_signed_angle(invertedPitch - pitchAngle)) <
            std::abs(wrap_signed_angle(principalPitch - pitchAngle));

        pitchAngle = wrap_signed_angle(useInvertedPitch ? invertedPitch : principalPitch);
        heading = wrap_heading(
            std::atan2(forward.x, -forward.z) * RAD_to_DEG +
            (useInvertedPitch ? 180.0f : 0.0f));
        rollAngle = wrap_signed_angle(
            std::atan2(-right.y, up.y) * RAD_to_DEG +
            (useInvertedPitch ? 180.0f : 0.0f));

        const float groundElevation = getGroundElevation();
        if (altitude <= groundElevation && velocityY < 0.0f) {
            if (!onGround) crashTimeRemaining = crashed_duration;
            altitude = groundElevation;
            velocityY = 0.0f;
            verticalSpeed = 0.0f;
            onGround = true;
        } else {
            onGround = false;
        }
    }

    void setPitchInput(float value) { pitchInput = clamp_finite(value, -1.0f, 1.0f); }
    void setRollInput(float value) { rollInput = clamp_finite(value, -1.0f, 1.0f); }
    void setYawInput(float value) { yawInput = clamp_finite(value, -1.0f, 1.0f); }

    void setThrottle(float value) 
    {
        if (std::isfinite(value)) throttle = std::clamp(value, 0.0f, 1.0f);
    }

    // Sets the terrain data for the simulation, including the heightmap and its properties.
    // Returns true if the terrain data is valid and successfully set; otherwise, returns false.
    bool setTerrainData(unsigned int dataPointer, int width, int height,
        float spacingXFeet, float spacingZFeet, float originXFeet, float originZFeet) 
    {
        if (dataPointer == 0 || width < 2 || height < 2 || width > 4096 || height > 4096 ||
            !std::isfinite(spacingXFeet) || spacingXFeet <= 0.0f ||
            !std::isfinite(spacingZFeet) || spacingZFeet <= 0.0f ||
            !std::isfinite(originXFeet) || !std::isfinite(originZFeet))
        {
            return false;
        }

        const std::size_t sampleCount = static_cast<std::size_t>(width) *
            static_cast<std::size_t>(height);
        const float* samples = reinterpret_cast<const float*>(
            static_cast<std::uintptr_t>(dataPointer));
        if (!std::all_of(samples, samples + sampleCount,
                [](float value) { return std::isfinite(value); })) {
            return false;
        }

        // Copy once per fetched tile neighborhood; the frame loop only reads the native cache.
        terrainHeightsMeters.assign(samples, samples + sampleCount);
        terrainWidth = width;
        terrainHeight = height;
        terrainSpacingXFeet = spacingXFeet;
        terrainSpacingZFeet = spacingZFeet;
        terrainOriginXFeet = originXFeet;
        terrainOriginZFeet = originZFeet;
        return true;
    }

    void clearTerrainData() {
        terrainHeightsMeters.clear();
        terrainWidth = 0;
        terrainHeight = 0;
    }

    float getPosX() const { return posX; }
    float getAltitude() const { return altitude; }
    float getPosZ() const { return posZ; }
    float getGroundElevation() const 
    {
        return sampleTerrainMeters(posX, posZ) * M_to_F;
    }
    float getAirspeed() const { return airspeed; }
    float getThrottle() const { return throttle * 100.0f; }
    float getPitch() const { return pitchAngle; }
    float getRoll() const { return rollAngle; }
    float getHeading() const { return heading; }
    float getVerticalSpeed() const { return verticalSpeed; }
    bool getCrashed() const { return crashTimeRemaining > 0.0f; }
};

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
