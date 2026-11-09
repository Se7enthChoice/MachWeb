#include "ws_msl.h"

#include <algorithm>
#include <cmath>

#include "env_terrain.h"
#include "utils.h"
#include "ws_radar.h"

namespace {
// Add future weapons here; each row is an immutable, type-specific flight profile.
constexpr std::array<MissileTypeConfig, 1> missileTypes = {{
    {1, 10.0f, 900.0f, 30.0f, 25.0f, 20.0f, 50.0f, true, true},
}};
// Launch just ahead of the aircraft and never initialize below a plausible missile speed.
constexpr float launchOffsetFeet = 35.0f;
constexpr float minimumLaunchSpeedKnots = 300.0f;
}

// Resolve a known weapon profile; unsupported IDs are rejected by launch/tick.
const MissileTypeConfig* MissileSystem::getTypeConfig(std::uint32_t typeId) {
    for (const MissileTypeConfig& type : missileTypes) {
        if (type.id == typeId) return &type;
    }
    return nullptr;
}

// Find a reusable slot, but do not allow more than eight missiles in powered flight.
int MissileSystem::findAvailableMissile() const {
    int activeCount = 0;
    int availableIndex = -1;
    for (int index = 0; index < maxMissiles; ++index) {
        if (!missiles[index].present) {
            if (availableIndex < 0) availableIndex = index;
        } else if (!missiles[index].exploded) {
            ++activeCount;
        }
    }
    return activeCount < maxActiveMissiles ? availableIndex : -1;
}

// Choose the nearest aircraft in the hit radius so overlapping target tracks resolve once.
std::uint32_t MissileSystem::findImpactTarget(
    float posX,
    float altitude,
    float posZ) const {
    std::uint32_t impactTargetId = 0;
    float nearestDistanceSquared = impactRadiusFeet * impactRadiusFeet;
    for (int index = 0; index < aircraftTargetCount; ++index) {
        const AircraftTarget& target = aircraftTargets[index];
        const float deltaX = target.posX - posX;
        const float deltaAltitude = target.altitude - altitude;
        const float deltaZ = target.posZ - posZ;
        const float distanceSquared =
            deltaX * deltaX + deltaAltitude * deltaAltitude + deltaZ * deltaZ;
        if (distanceSquared <= nearestDistanceSquared) {
            nearestDistanceSquared = distanceSquared;
            impactTargetId = target.id;
        }
    }
    return impactTargetId;
}

// Preserve the final position and hit identity long enough for clients to render/report impact.
void MissileSystem::detonate(Missile& missile, std::uint32_t impactTargetId) {
    missile.exploded = true;
    missile.impactTargetId = impactTargetId;
    missile.explosionTimeRemaining = explosionDurationSeconds;
}

// Creates a missile with the nearest launch-time radar track, if one is within weapon range.
int MissileSystem::launch(
    std::uint32_t typeId,
    float posX,
    float altitude,
    float posZ,
    float airspeedKnots,
    float heading,
    float pitch,
    const Radar& radar) {
    const MissileTypeConfig* type = getTypeConfig(typeId);
    if (!type) return 0;
    if (!std::isfinite(posX) || !std::isfinite(altitude) || !std::isfinite(posZ) ||
        !std::isfinite(airspeedKnots) || !std::isfinite(heading) || !std::isfinite(pitch)) {
        return 0;
    }
    const int missileIndex = findAvailableMissile();
    if (missileIndex < 0) return 0;

    std::uint32_t targetId = 0;
    float nearestRangeNm = type->maxRangeNm;
    bool hasTrack = false;
    for (int index = 0; index < radar.getContactCount(); ++index) {
        hasTrack = true;
        const std::uint32_t candidateId = radar.getContactTargetId(index);
        float targetX = 0.0f;
        float targetAltitude = 0.0f;
        float targetZ = 0.0f;
        if (!radar.getTargetPosition(candidateId, targetX, targetAltitude, targetZ)) continue;
        const float deltaX = targetX - posX;
        const float deltaAltitude = targetAltitude - altitude;
        const float deltaZ = targetZ - posZ;
        const float rangeNm = std::sqrt(
            deltaX * deltaX + deltaAltitude * deltaAltitude + deltaZ * deltaZ) /
            FT_per_NM;
        if (rangeNm <= nearestRangeNm) {
            nearestRangeNm = rangeNm;
            targetId = candidateId;
        }
    }
    if (type->radarGuided && hasTrack && targetId == 0) return 0;

    Vector3 forward;
    Vector3 up;
    Vector3 right;
    get_orientation_basis(heading, pitch, 0.0f, forward, up, right);
    const float launchSpeedKnots = std::clamp(
        airspeedKnots, minimumLaunchSpeedKnots, type->maxSpeedKnots);
    Missile missile;
    missile.present = true;
    missile.id = nextMissileId++;
    if (nextMissileId == 0) nextMissileId = 1;
    missile.typeId = type->id;
    missile.targetId = type->radarGuided ? targetId : 0;
    missile.posX = posX + forward.x * launchOffsetFeet;
    missile.altitude = altitude + forward.y * launchOffsetFeet;
    missile.posZ = posZ + forward.z * launchOffsetFeet;
    const float launchSpeed = launchSpeedKnots * KTs_to_FPS;
    missile.velocityX = forward.x * launchSpeed;
    missile.velocityY = forward.y * launchSpeed;
    missile.velocityZ = forward.z * launchSpeed;
    missile.lifetimeRemaining = type->lifetimeSeconds;
    missiles[missileIndex] = missile;
    return missile.targetId == 0 ? 1 : 2;
}

// Integrates each flight in bounded steps, steering toward its track and resolving fuses/hits.
void MissileSystem::tick(float dt, const Terrain& terrain, const Radar& radar) {
    if (!std::isfinite(dt) || dt <= 0.0f) return;
    dt = std::min(dt, 0.1f);

    for (Missile& missile : missiles) {
        if (!missile.present) continue;
        if (missile.exploded) {
            missile.explosionTimeRemaining -= dt;
            if (missile.explosionTimeRemaining <= 0.0f) missile = {};
            continue;
        }

        // Expire unknown types explicitly; no missile should become an immortal fallback.
        const MissileTypeConfig* type = getTypeConfig(missile.typeId);
        if (!type) {
            missile = {};
            continue;
        }
        missile.lifetimeRemaining -= dt;

        // Accelerate up to the profile's cap, then rotate direction by turn-rate and g limits.
        const float currentSpeed = std::sqrt(
            missile.velocityX * missile.velocityX +
            missile.velocityY * missile.velocityY +
            missile.velocityZ * missile.velocityZ);
        if (!std::isfinite(currentSpeed) || currentSpeed < 1.0f) {
            missile = {};
            continue;
        }
        const float currentSpeedKnots = currentSpeed / KTs_to_FPS;
        const float nextSpeedKnots = std::min(
            type->maxSpeedKnots,
            currentSpeedKnots + type->accelerationKnotsPerSecond * dt);
        const float nextSpeed = nextSpeedKnots * KTs_to_FPS;
        Vector3 direction = normalized({
            missile.velocityX,
            missile.velocityY,
            missile.velocityZ,
        });

        float targetX = 0.0f;
        float targetAltitude = 0.0f;
        float targetZ = 0.0f;
        const bool hasTarget = missile.targetId != 0 && radar.getTargetPosition(
            missile.targetId, targetX, targetAltitude, targetZ);

        // Check every aircraft, not just the guided target, so unguided shots can hit too.
        const std::uint32_t nearbyAircraftId = findImpactTarget(
            missile.posX, missile.altitude, missile.posZ);
        if (nearbyAircraftId != 0) {
            detonate(missile, nearbyAircraftId);
            continue;
        }

        if (hasTarget) {
            const Vector3 toTarget{
                targetX - missile.posX,
                targetAltitude - missile.altitude,
                targetZ - missile.posZ,
            };
            const float distanceToTarget = std::sqrt(dot(toTarget, toTarget));
            if (distanceToTarget <= impactRadiusFeet) {
                detonate(missile, missile.targetId);
                continue;
            }

            const Vector3 desiredDirection = normalized(toTarget);
            const float angle = std::acos(std::clamp(dot(direction, desiredDirection), -1.0f, 1.0f));
            const float turnLimit = std::min(
                type->maxTurnRateDegreesPerSecond * DEG_to_RAD * dt,
                type->maxLateralG * gravity / std::max(currentSpeed, 1.0f) * dt);
            if (angle > 0.0001f) {
                Vector3 turnAxis = normalized(cross(direction, desiredDirection));
                if (dot(turnAxis, turnAxis) < 0.5f) {
                    turnAxis = normalized(cross(direction, {0.0f, 1.0f, 0.0f}));
                    if (dot(turnAxis, turnAxis) < 0.5f) {
                        turnAxis = normalized(cross(direction, {1.0f, 0.0f, 0.0f}));
                    }
                }
                direction = normalized(rotate_around_axis(
                    direction, turnAxis, std::min(angle, turnLimit)));
            }
        }

        missile.velocityX = direction.x * nextSpeed;
        missile.velocityY = direction.y * nextSpeed;
        missile.velocityZ = direction.z * nextSpeed;
        const float stepDistance = nextSpeed * dt;
        missile.posX += direction.x * stepDistance;
        missile.altitude += direction.y * stepDistance;
        missile.posZ += direction.z * stepDistance;
        missile.distanceTravelled += stepDistance;

        if (hasTarget) {
            const Vector3 toTarget{
                targetX - missile.posX,
                targetAltitude - missile.altitude,
                targetZ - missile.posZ,
            };
            if (dot(toTarget, toTarget) <= impactRadiusFeet * impactRadiusFeet) {
                detonate(missile, missile.targetId);
                continue;
            }
        }

        const std::uint32_t impactTargetId = findImpactTarget(
            missile.posX, missile.altitude, missile.posZ);
        if (impactTargetId != 0) {
            detonate(missile, impactTargetId);
            continue;
        }

        // Terrain hits and maximum-range expiry explode without crediting an aircraft.
        if (missile.altitude <= terrain.getElevationFeet(missile.posX, missile.posZ)) {
            detonate(missile);
        } else if (missile.distanceTravelled >= type->maxRangeNm * FT_per_NM) {
            detonate(missile);
        } else if (missile.lifetimeRemaining <= 0.0f) {
            detonate(missile);
        }
    }
}

// Begin each simulation frame with an empty set to avoid retaining departed aircraft.
void MissileSystem::clearAircraftTargets() {
    aircraftTargetCount = 0;
}

// Reject malformed or excess positions before they reach the collision loop.
bool MissileSystem::addAircraftTarget(
    std::uint32_t id,
    float posX,
    float altitude,
    float posZ) {
    if (id == 0 || aircraftTargetCount >= maxAircraftTargets ||
        !std::isfinite(posX) || !std::isfinite(altitude) || !std::isfinite(posZ)) {
        return false;
    }
    aircraftTargets[aircraftTargetCount++] = {id, posX, altitude, posZ};
    return true;
}

// Report all live flights and their short-lived explosion snapshots to clients.
int MissileSystem::getCount() const {
    int count = 0;
    for (const Missile& missile : missiles) {
        if (missile.present) ++count;
    }
    return count;
}

// Resolve compact indices safely without exposing internal array slots.
const MissileSystem::Missile* MissileSystem::getMissile(int index) const {
    if (index < 0) return nullptr;
    for (const Missile& missile : missiles) {
        if (!missile.present) continue;
        if (index-- == 0) return &missile;
    }
    return nullptr;
}

// Snapshot accessors return neutral defaults for invalid indices.
std::uint32_t MissileSystem::getId(int index) const {
    const Missile* missile = getMissile(index);
    return missile ? missile->id : 0;
}

std::uint32_t MissileSystem::getTypeId(int index) const {
    const Missile* missile = getMissile(index);
    return missile ? missile->typeId : 0;
}

std::uint32_t MissileSystem::getTargetId(int index) const {
    const Missile* missile = getMissile(index);
    return missile ? missile->targetId : 0;
}

float MissileSystem::getPosX(int index) const {
    const Missile* missile = getMissile(index);
    return missile ? missile->posX : 0.0f;
}

float MissileSystem::getAltitude(int index) const {
    const Missile* missile = getMissile(index);
    return missile ? missile->altitude : 0.0f;
}

float MissileSystem::getPosZ(int index) const {
    const Missile* missile = getMissile(index);
    return missile ? missile->posZ : 0.0f;
}

float MissileSystem::getHeading(int index) const {
    const Missile* missile = getMissile(index);
    if (!missile) return 0.0f;
    return wrap_heading(std::atan2(missile->velocityX, -missile->velocityZ) * RAD_to_DEG);
}

float MissileSystem::getPitch(int index) const {
    const Missile* missile = getMissile(index);
    if (!missile) return 0.0f;
    const float horizontalSpeed = std::sqrt(
        missile->velocityX * missile->velocityX +
        missile->velocityZ * missile->velocityZ);
    return std::atan2(missile->velocityY, horizontalSpeed) * RAD_to_DEG;
}

bool MissileSystem::getExploded(int index) const {
    const Missile* missile = getMissile(index);
    return missile && missile->exploded;
}

// The hit target remains available during the explosion window for multiplayer crash events.
std::uint32_t MissileSystem::getImpactTargetId(int index) const {
    const Missile* missile = getMissile(index);
    return missile ? missile->impactTargetId : 0;
}

// Only missiles in powered flight are active RWR threats.
bool MissileSystem::getTriggersRwr(int index) const {
    const Missile* missile = getMissile(index);
    const MissileTypeConfig* type = missile ? getTypeConfig(missile->typeId) : nullptr;
    return type && type->triggersRwr && !missile->exploded;
}
