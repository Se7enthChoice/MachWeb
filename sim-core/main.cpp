#include <emscripten/bind.h>
#include <emscripten/emscripten.h>
#include <algorithm>
#include <cmath>

class SimEngine {
private:
    static constexpr float ktsToFeetPerSecond = 1.68781f;
    static constexpr float gravity = 32.174f;
    static constexpr float degreesToRadians = 3.14159265f / 180.0f;
    static constexpr float radiansToDegrees = 180.0f / 3.14159265f;
    static constexpr float maxAirspeed = 850.0f;

    float posX = 0.0f;
    float altitude = 5000.0f;
    float posZ = 0.0f;
    float velocityX = 0.0f;
    float velocityY = 0.0f;
    float velocityZ = -300.0f * ktsToFeetPerSecond;
    float airspeed = 300.0f;
    float throttle = 0.43f;

    float pitchAngle = 0.0f;
    float rollAngle = 0.0f;
    float heading = 0.0f;
    float verticalSpeed = 0.0f;

    float pitchInput = 0.0f;
    float rollInput = 0.0f;
    float yawInput = 0.0f;
    bool autoLevelEnabled = false;

    static float clampInput(float value) {
        return std::isfinite(value) ? std::clamp(value, -1.0f, 1.0f) : 0.0f;
    }

    static float wrapHeading(float angle) {
        angle = std::fmod(angle, 360.0f);
        return angle < 0.0f ? angle + 360.0f : angle;
    }

    static float clampFinite(float value, float minimum, float maximum) {
        return std::isfinite(value) ? std::clamp(value, minimum, maximum) : minimum;
    }

public:
    void tick(float dt) {
        if (!std::isfinite(dt) || dt <= 0.0f) return;
        dt = std::min(dt, 0.1f);

        float speedFeetPerSecond = std::sqrt(
            velocityX * velocityX + velocityY * velocityY + velocityZ * velocityZ);
        if (!std::isfinite(speedFeetPerSecond)) {
            velocityX = 0.0f;
            velocityY = 0.0f;
            velocityZ = -300.0f * ktsToFeetPerSecond;
            speedFeetPerSecond = 300.0f * ktsToFeetPerSecond;
        }
        airspeed = clampFinite(speedFeetPerSecond / ktsToFeetPerSecond, 0.0f, maxAirspeed);

        float targetPitch = pitchInput;
        float targetRoll = rollInput;
        if (autoLevelEnabled) {
            if (std::abs(pitchInput) < 0.01f) targetPitch -= pitchAngle / 12.0f;
            if (std::abs(rollInput) < 0.01f) targetRoll -= rollAngle / 20.0f;
        }

        pitchAngle += std::clamp(targetPitch, -1.0f, 1.0f) * 55.0f * dt;
        rollAngle += std::clamp(targetRoll, -1.0f, 1.0f) * 100.0f * dt;
        pitchAngle = std::clamp(pitchAngle, -85.0f, 85.0f);
        rollAngle = std::clamp(rollAngle, -85.0f, 85.0f);

        const float pitchRad = pitchAngle * degreesToRadians;
        const float rollRad = rollAngle * degreesToRadians;
        const float sinRoll = std::sin(rollRad);
        const float cosRoll = std::cos(rollRad);
        const float cosPitch = std::cos(pitchRad);
        const float headingRad = heading * degreesToRadians;
        const float sinPitch = std::sin(pitchRad);
        const float sinHeading = std::sin(headingRad);
        const float cosHeading = std::cos(headingRad);

        const float forwardX = sinHeading * cosPitch;
        const float forwardY = sinPitch;
        const float forwardZ = -cosHeading * cosPitch;
        const float upX = -sinHeading * sinPitch * cosRoll + cosHeading * sinRoll;
        const float upY = cosPitch * cosRoll;
        const float upZ = cosHeading * sinPitch * cosRoll + sinHeading * sinRoll;

        const float speedX = velocityX / std::max(speedFeetPerSecond, 1.0f);
        const float speedY = velocityY / std::max(speedFeetPerSecond, 1.0f);
        const float speedZ = velocityZ / std::max(speedFeetPerSecond, 1.0f);
        const float upAlongVelocity = upX * speedX + upY * speedY + upZ * speedZ;
        float liftX = upX - upAlongVelocity * speedX;
        float liftY = upY - upAlongVelocity * speedY;
        float liftZ = upZ - upAlongVelocity * speedZ;
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

        const float liftFactor = std::clamp(airspeed / 100.0f, 0.0f, 1.0f);
        const float lift = std::min(
            gravity * liftFactor / std::max(cosRoll, 0.2f),
            gravity * 3.0f);
        const float bankedTurnRate = radiansToDegrees * lift * sinRoll /
            std::max(speedFeetPerSecond, 50.0f);
        heading = wrapHeading(heading + (bankedTurnRate + yawInput * 45.0f) * dt);

        const float targetAirspeed = 100.0f + throttle * 465.0f;
        const float thrustAcceleration =
            (targetAirspeed - airspeed) * 0.4f * ktsToFeetPerSecond;

        velocityX += (forwardX * thrustAcceleration + liftX * lift) * dt;
        velocityY += (forwardY * thrustAcceleration + liftY * lift - gravity) * dt;
        velocityZ += (forwardZ * thrustAcceleration + liftZ * lift) * dt;

        speedFeetPerSecond = std::sqrt(
            velocityX * velocityX + velocityY * velocityY + velocityZ * velocityZ);
        const float maxSpeedFeetPerSecond = maxAirspeed * ktsToFeetPerSecond;
        if (speedFeetPerSecond > maxSpeedFeetPerSecond) {
            const float scale = maxSpeedFeetPerSecond / speedFeetPerSecond;
            velocityX *= scale;
            velocityY *= scale;
            velocityZ *= scale;
        }

        // Keep the simplified aircraft model coordinated: travel follows the nose
        // so the first-person view never points away from the flight path.
        const float alignedHeadingRad = heading * degreesToRadians;
        const float alignedSpeed = std::sqrt(
            velocityX * velocityX + velocityY * velocityY + velocityZ * velocityZ);
        velocityX = std::sin(alignedHeadingRad) * cosPitch * alignedSpeed;
        velocityY = sinPitch * alignedSpeed;
        velocityZ = -std::cos(alignedHeadingRad) * cosPitch * alignedSpeed;

        posX += velocityX * dt;
        altitude += velocityY * dt;
        posZ += velocityZ * dt;
        verticalSpeed = velocityY * 60.0f;

        posX = clampFinite(posX, -100000000.0f, 100000000.0f);
        posZ = clampFinite(posZ, -100000000.0f, 100000000.0f);
        altitude = clampFinite(altitude, -1000000.0f, 1000000.0f);
        verticalSpeed = clampFinite(
            verticalSpeed,
            -maxAirspeed * ktsToFeetPerSecond * 60.0f,
            maxAirspeed * ktsToFeetPerSecond * 60.0f);
        airspeed = clampFinite(
            std::sqrt(velocityX * velocityX + velocityY * velocityY + velocityZ * velocityZ) /
                ktsToFeetPerSecond,
            0.0f,
            maxAirspeed);

        if (altitude <= 0.0f && velocityY < 0.0f) {
            altitude = 0.0f;
            velocityY = 0.0f;
            verticalSpeed = 0.0f;
            pitchAngle = std::max(pitchAngle, 0.0f);
        }
    }

    void setPitchInput(float value) { pitchInput = clampInput(value); }
    void setRollInput(float value) { rollInput = clampInput(value); }
    void setYawInput(float value) { yawInput = clampInput(value); }
    void setThrottle(float value) {
        if (std::isfinite(value)) throttle = std::clamp(value, 0.0f, 1.0f);
    }
    void setAutoLevel(bool enabled) { autoLevelEnabled = enabled; }

    float getPosX() const { return posX; }
    float getAltitude() const { return altitude; }
    float getPosZ() const { return posZ; }
    float getAirspeed() const { return airspeed; }
    float getThrottle() const { return throttle * 100.0f; }
    float getPitch() const { return pitchAngle; }
    float getRoll() const { return rollAngle; }
    float getHeading() const { return heading; }
    float getVerticalSpeed() const { return verticalSpeed; }
};

EMSCRIPTEN_BINDINGS(sim_engine) {
    emscripten::class_<SimEngine>("SimEngine")
        .constructor<>()
        .function("tick", &SimEngine::tick)
        .function("setPitchInput", &SimEngine::setPitchInput)
        .function("setRollInput", &SimEngine::setRollInput)
        .function("setYawInput", &SimEngine::setYawInput)
        .function("setThrottle", &SimEngine::setThrottle)
        .function("setAutoLevel", &SimEngine::setAutoLevel)
        .function("getPosX", &SimEngine::getPosX)
        .function("getAltitude", &SimEngine::getAltitude)
        .function("getPosZ", &SimEngine::getPosZ)
        .function("getAirspeed", &SimEngine::getAirspeed)
        .function("getThrottle", &SimEngine::getThrottle)
        .function("getPitch", &SimEngine::getPitch)
        .function("getRoll", &SimEngine::getRoll)
        .function("getHeading", &SimEngine::getHeading)
        .function("getVerticalSpeed", &SimEngine::getVerticalSpeed);
}
