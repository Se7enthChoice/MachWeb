#include "fm_aircraft.h"

#include <algorithm>
#include <cmath>

#include "utils.h"

namespace {
// Landing-gear dimensions, touchdown limits, and ground-contact response in simulator units.
constexpr float LANDING_GEAR_CLEARANCE_FEET = 15.0f;
constexpr float LANDING_GEAR_SLOPE_SAMPLE_FEET = 50.0f;
constexpr float MAX_SAFE_LANDING_SINK_RATE_FPS = 15.0f;
constexpr float MAX_GROUND_ATTITUDE_DEGREES = 30.0f;
constexpr float GROUND_BRAKING_DECELERATION_FPS2 = 20.0f;
}

// Sets the initial altitude and aligns velocity with the selected heading.
void FlightModel::setInitialConditions(float initialAltitude, float initialHeading) {
    altitude = clamp_finite(initialAltitude, 0.0f, 60000.0f);
    heading = wrap_heading(clamp_finite(initialHeading, 0.0f, 360.0f));
    const float speedFeetPerSecond = airspeed * KTs_to_FPS;
    const float headingRadians = heading * DEG_to_RAD;
    velocityX = std::sin(headingRadians) * speedFeetPerSecond;
    velocityY = 0.0f;
    velocityZ = -std::cos(headingRadians) * speedFeetPerSecond;
    pitchAngle = 0.0f;
    rollAngle = 0.0f;
    pitchRate = 0.0f;
    rollRate = 0.0f;
    yawRate = 0.0f;
    verticalSpeed = 0.0f;
    crashTimeRemaining = 0.0f;
    onGround = false;
    // Each new flight starts with deployed gear and no pending takeoff rotation.
    landingGearDown = true;
    gearRotationRequested = false;
}

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

    // Apply wheel force against ground-relative motion, accounting for wind, only on the gear.
    if (brakeInput && onGround && landingGearDown) {
        const float groundVelocityX = velocityX + windX;
        const float groundVelocityZ = velocityZ + windZ;
        const float groundSpeed = std::sqrt(
            groundVelocityX * groundVelocityX + groundVelocityZ * groundVelocityZ);
        const float reducedGroundSpeed = std::max(
            0.0f,
            groundSpeed - GROUND_BRAKING_DECELERATION_FPS2 * dt);
        const float speedScale = groundSpeed > 0.001f
            ? reducedGroundSpeed / groundSpeed
            : 0.0f;
        velocityX = groundVelocityX * speedScale - windX;
        velocityZ = groundVelocityZ * speedScale - windZ;
    }

    posX += (velocityX + windX) * dt;
    altitude += velocityY * dt;
    posZ += (velocityZ + windZ) * dt;
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

    // Contact height is the wheel clearance with gear down, or the terrain itself with gear up.
    const float groundElevation = terrain.getElevationFeet(posX, posZ);
    const float contactAltitude = groundElevation +
        (landingGearDown ? LANDING_GEAR_CLEARANCE_FEET : 0.0f);

    // Latch a nose-up request near contact so ground-slope alignment cannot undo rotation.
    if (landingGearDown && altitude <= contactAltitude && pitchInput > 0.0f) {
        gearRotationRequested = true;
    }

    if (altitude <= contactAltitude) {
        // A retracted-gear strike always crashes; a gear-down touchdown crashes only above
        // the safe sink-rate limit.
        if (!onGround && (!landingGearDown ||
            velocityY < -MAX_SAFE_LANDING_SINK_RATE_FPS)) {
            crashTimeRemaining = crashed_duration;
        }
        altitude = contactAltitude;
        if (velocityY < 0.0f) velocityY = 0.0f;
        verticalSpeed = 0.0f;
        onGround = true;
        if (landingGearDown) {
            // Estimate runway pitch and cross-slope roll from terrain samples around the wheels.
            const float sampleDistance = LANDING_GEAR_SLOPE_SAMPLE_FEET;
            const float sinHeading = std::sin(heading * DEG_to_RAD);
            const float cosHeading = std::cos(heading * DEG_to_RAD);
            const float aheadElevation = terrain.getElevationFeet(
                posX + sinHeading * sampleDistance,
                posZ - cosHeading * sampleDistance);
            const float behindElevation = terrain.getElevationFeet(
                posX - sinHeading * sampleDistance,
                posZ + cosHeading * sampleDistance);
            const float rightElevation = terrain.getElevationFeet(
                posX + cosHeading * sampleDistance,
                posZ + sinHeading * sampleDistance);
            const float leftElevation = terrain.getElevationFeet(
                posX - cosHeading * sampleDistance,
                posZ - sinHeading * sampleDistance);
            // Preserve a commanded pitch while rotating for takeoff; otherwise follow the slope.
            if (!gearRotationRequested) {
                pitchAngle = std::clamp(
                    std::atan((aheadElevation - behindElevation) / (2.0f * sampleDistance)) *
                        RAD_to_DEG,
                    -MAX_GROUND_ATTITUDE_DEGREES,
                    MAX_GROUND_ATTITUDE_DEGREES);
                pitchRate = 0.0f;
            }
            // Pilot bank input takes priority over terrain roll alignment.
            if (rollInput == 0.0f) {
                rollAngle = std::clamp(
                    std::atan((leftElevation - rightElevation) / (2.0f * sampleDistance)) *
                        RAD_to_DEG,
                    -MAX_GROUND_ATTITUDE_DEGREES,
                    MAX_GROUND_ATTITUDE_DEGREES);
                rollRate = 0.0f;
            }
        }
    } else {
        onGround = false;
        // Clear the rotation latch once airborne so a later landing aligns normally.
        gearRotationRequested = false;
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

// Sets whether terrain contact uses the 15 ft wheel clearance or the terrain surface.
void FlightModel::setLandingGearDown(bool down) {
    landingGearDown = down;
    gearRotationRequested = false;
    // Retracting the gear ends wheel-supported contact immediately.
    if (!down) onGround = false;
}

// Applies wheel braking only while the landing gear is on the ground.
void FlightModel::setBrakeInput(bool braking) {
    brakeInput = braking;
}

// Stores bounded east/north ambient wind in feet per second.
void FlightModel::setWind(float eastKnots, float northKnots) {
    windX = clamp_finite(eastKnots, -150.0f, 150.0f) * KTs_to_FPS;
    windZ = -clamp_finite(northKnots, -150.0f, 150.0f) * KTs_to_FPS;
}
