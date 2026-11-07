#include "fm_aircraft.h"

#include <algorithm>
#include <cmath>

#include "utils.h"

// Advances flight dynamics by dt seconds and resolves contact against the terrain.
void FlightModel::tick(float dt, const Terrain& terrain) {
    crashTimeRemaining = std::max(0.0f, crashTimeRemaining - dt);

    // Recover from invalid velocity state and derive current airspeed.
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
    get_orientation_basis(heading, pitchAngle, rollAngle, forward, up, right);
    const Vector3 velocity{velocityX, velocityY, velocityZ};
    const float angleOfAttack = std::atan2(-dot(velocity, up), dot(velocity, forward));
    const float angleOfAttackDegrees = angleOfAttack * RAD_to_DEG;
    const float pitchDynamicPressure = std::pow(
        std::clamp(airspeed / cruise_airspeed, 0.0f, 1.35f), 2.0f);
    const float controlAuthority = std::clamp(airspeed / cruise_airspeed, 0.35f, 1.35f);
    const float maxRollRate = 100.0f * controlAuthority;
    const float maxYawRate = 10.0f * controlAuthority;
    const float targetRollRate = rollInput * maxRollRate;
    const float targetYawRate = yawInput * maxYawRate;

    // Apply control authority and aerodynamic damping to angular rates.
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

    // Resolve the lift direction perpendicular to the current velocity.
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

    // Integrate thrust, lift, drag, and gravity; then bound speed and position.
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

    // Rotate the aircraft basis and recover its Euler attitude angles.
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

    // Clamp descent at terrain elevation and start the crash timer on contact.
    const float groundElevation = terrain.getElevationFeet(posX, posZ);
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

// Stores a finite pitch command clamped to the normalized [-1, 1] input range.
void FlightModel::setPitchInput(float value) {
    pitchInput = clamp_finite(value, -1.0f, 1.0f);
}

// Stores a finite roll command clamped to the normalized [-1, 1] input range.
void FlightModel::setRollInput(float value) {
    rollInput = clamp_finite(value, -1.0f, 1.0f);
}

// Stores a finite yaw command clamped to the normalized [-1, 1] input range.
void FlightModel::setYawInput(float value) {
    yawInput = clamp_finite(value, -1.0f, 1.0f);
}

// Updates throttle for finite input, clamping the normalized value to [0, 1].
void FlightModel::setThrottle(float value) {
    if (std::isfinite(value)) throttle = std::clamp(value, 0.0f, 1.0f);
}
