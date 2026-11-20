#include "ws_msl.h"

#include <algorithm>
#include <cmath>

#include "env_terrain.h"
#include "utils.h"
#include "ws_radar.h"

namespace {
// Add future weapons here; each row is an immutable, type-specific flight profile.
constexpr std::array<MissileTypeConfig, 2> missileTypes = {{
    {1, 10.0f, 900.0f, 30.0f, 25.0f, 20.0f, 50.0f, MissileSeeker::Radar, true},
    {2, 8.0f, 1100.0f, 45.0f, 45.0f, 30.0f, 35.0f, MissileSeeker::Infrared, false},
}};
// Launch just ahead of the aircraft and never initialize below a plausible missile speed.
constexpr float launchOffsetFeet = 35.0f;
constexpr float minimumLaunchSpeedKnots = 450.0f;
// Decoys outside this seeker envelope cannot compete with the intended aircraft return.
constexpr float countermeasureMaxRangeFeet = 2.5f * FT_per_NM;

// Keep burn/drop lifetimes consistent with the age limits in multiplayer telemetry.
float getCountermeasureLifetime(CountermeasureType type) {
    return type == CountermeasureType::Chaff ? 8.0f : 4.0f;
}

// A simple exponential signature fade makes freshly released decoys most effective.
float getCountermeasureSignature(CountermeasureType type, float ageSeconds) {
    if (type == CountermeasureType::Chaff) {
        return 3.2f * std::exp(-ageSeconds / 3.5f);
    }
    return 7.0f * std::exp(-ageSeconds / 1.8f);
}

bool isValidCountermeasureType(CountermeasureType type) {
    return type == CountermeasureType::Chaff || type == CountermeasureType::Flare;
}
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

std::uint32_t MissileSystem::findImpactableAircraftTargetId(std::uint32_t targetId) const {
    for (int index = 0; index < aircraftTargetCount; ++index) {
        if (aircraftTargets[index].id == targetId) return targetId;
    }
    return 0;
}

// Preserve the final position and hit identity long enough for clients to render/report impact.
void MissileSystem::detonate(Missile& missile, std::uint32_t impactTargetId) {
    missile.exploded = true;
    missile.impactTargetId = impactTargetId;
    missile.explosionTimeRemaining = explosionDurationSeconds;
}

// Creates a missile against the selected or nearest launch-time radar contact.
int MissileSystem::launch(
    std::uint32_t typeId,
    std::uint32_t selectedTargetId,
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
    if (missileIndex < 0) return 3;

    // Only an explicitly selected track guides a missile; no selection fires it unguided.
    std::uint32_t targetId = 0;
    if (selectedTargetId != 0) {
        bool selectedTrackFound = false;
        bool selectedTargetPositionFound = false;
        for (int index = 0; index < radar.getContactCount(); ++index) {
            const std::uint32_t candidateId = radar.getContactTargetId(index);
            if (candidateId != selectedTargetId) continue;
            selectedTrackFound = true;
            float targetX = 0.0f;
            float targetAltitude = 0.0f;
            float targetZ = 0.0f;
            if (!radar.getTargetPosition(candidateId, targetX, targetAltitude, targetZ)) break;
            selectedTargetPositionFound = true;
            const float deltaX = targetX - posX;
            const float deltaAltitude = targetAltitude - altitude;
            const float deltaZ = targetZ - posZ;
            const float rangeNm = std::sqrt(
                deltaX * deltaX + deltaAltitude * deltaAltitude + deltaZ * deltaZ) /
                FT_per_NM;
            if (rangeNm <= type->maxRangeNm) targetId = candidateId;
            break;
        }
        if (!selectedTrackFound || !selectedTargetPositionFound) return 4;
        if (targetId == 0) return 5;
    }

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
    missile.targetId = targetId;
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

    // Dispenser timers and local decoys advance on the same bounded simulation clock.
    chaffCooldown = std::max(0.0f, chaffCooldown - dt);
    flareCooldown = std::max(0.0f, flareCooldown - dt);
    for (Countermeasure& countermeasure : countermeasures) {
        if (!countermeasure.present) continue;
        countermeasure.ageSeconds += dt;
        // Chaff sheds forward speed faster; both decoy types fall under gravity.
        const float drag = countermeasure.type == CountermeasureType::Chaff ? 0.55f : 0.18f;
        const float retainedVelocity = std::exp(-drag * dt);
        countermeasure.velocityX *= retainedVelocity;
        countermeasure.velocityY =
            countermeasure.velocityY * retainedVelocity - gravity * dt;
        countermeasure.velocityZ *= retainedVelocity;
        countermeasure.posX += countermeasure.velocityX * dt;
        countermeasure.altitude += countermeasure.velocityY * dt;
        countermeasure.posZ += countermeasure.velocityZ * dt;
        if (countermeasure.ageSeconds >= getCountermeasureLifetime(countermeasure.type) ||
            countermeasure.altitude <= terrain.getElevationFeet(
                countermeasure.posX, countermeasure.posZ)) {
            countermeasure = {};
        }
    }

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

        // Consider only a matching decoy in the seeker cone and within its acquisition range.
        bool targetingCountermeasure = false;
        float selectedCountermeasureSignal = 0.0f;
        const float aircraftRange = hasTarget
            ? std::sqrt(
                (targetX - missile.posX) * (targetX - missile.posX) +
                (targetAltitude - missile.altitude) * (targetAltitude - missile.altitude) +
                (targetZ - missile.posZ) * (targetZ - missile.posZ))
            : 0.0f;
        const float aircraftSignal = hasTarget
            ? 1.0f / (1.0f + aircraftRange * aircraftRange /
                (FT_per_NM * FT_per_NM))
            : 0.0f;
        const CountermeasureType compatibleCountermeasure =
            type->seeker == MissileSeeker::Radar
                ? CountermeasureType::Chaff
                : CountermeasureType::Flare;
        const float seekerFieldOfViewCosine = std::cos(35.0f * DEG_to_RAD);
        const auto considerCountermeasure = [&](std::uint32_t id,
                                                 CountermeasureType countermeasureType,
                                                 float countermeasureX,
                                                 float countermeasureAltitude,
                                                 float countermeasureZ,
                                                 float signature) {
            if (!hasTarget || countermeasureType != compatibleCountermeasure) return;
            const Vector3 relative{
                countermeasureX - missile.posX,
                countermeasureAltitude - missile.altitude,
                countermeasureZ - missile.posZ,
            };
            const float distanceSquared = dot(relative, relative);
            if (distanceSquared > countermeasureMaxRangeFeet * countermeasureMaxRangeFeet ||
                distanceSquared < 1.0f) {
                return;
            }
            const Vector3 decoyDirection = normalized(relative);
            if (dot(direction, decoyDirection) < seekerFieldOfViewCosine) return;

            const float rangeNm = std::sqrt(distanceSquared) / FT_per_NM;
            const float decoySignal = signature / (1.0f + rangeNm * rangeNm);
            // Stable per missile/decoy variation avoids making every dispense an automatic seduction.
            const float decoyBias =
                0.75f + static_cast<float>((missile.id * 31u + id * 17u) % 100u) / 100.0f;
            if (decoySignal <= aircraftSignal * decoyBias ||
                decoySignal <= selectedCountermeasureSignal) {
                return;
            }
            selectedCountermeasureSignal = decoySignal;
            targetX = countermeasureX;
            targetAltitude = countermeasureAltitude;
            targetZ = countermeasureZ;
            targetingCountermeasure = true;
        };
        for (int index = 0; index < countermeasureTargetCount; ++index) {
            const CountermeasureTarget& target = countermeasureTargets[index];
            considerCountermeasure(
                target.id,
                target.type,
                target.posX,
                target.altitude,
                target.posZ,
                getCountermeasureSignature(target.type, target.ageSeconds));
        }
        for (const Countermeasure& countermeasure : countermeasures) {
            if (!countermeasure.present) continue;
            considerCountermeasure(
                countermeasure.id,
                countermeasure.type,
                countermeasure.posX,
                countermeasure.altitude,
                countermeasure.posZ,
                getCountermeasureSignature(countermeasure.type, countermeasure.ageSeconds));
        }

        if (hasTarget) {
            const Vector3 toTarget{
                targetX - missile.posX,
                targetAltitude - missile.altitude,
                targetZ - missile.posZ,
            };
            const float distanceToTarget = std::sqrt(dot(toTarget, toTarget));
            if (distanceToTarget <= impactRadiusFeet) {
                detonate(
                    missile,
                    targetingCountermeasure
                        ? 0
                        : findImpactableAircraftTargetId(missile.targetId));
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
                detonate(
                    missile,
                    targetingCountermeasure
                        ? 0
                        : findImpactableAircraftTargetId(missile.targetId));
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

void MissileSystem::clearCountermeasureTargets() {
    countermeasureTargetCount = 0;
}

bool MissileSystem::addCountermeasureTarget(
    std::uint32_t id,
    CountermeasureType type,
    float posX,
    float altitude,
    float posZ,
    float ageSeconds) {
    // Peer data is untrusted: reject expired decoys, non-finite coordinates, and excess targets.
    if (id == 0 || !isValidCountermeasureType(type) ||
        countermeasureTargetCount >= maxCountermeasureTargets ||
        !std::isfinite(posX) || !std::isfinite(altitude) || !std::isfinite(posZ) ||
        !std::isfinite(ageSeconds) || ageSeconds < 0.0f ||
        ageSeconds >= getCountermeasureLifetime(type)) {
        return false;
    }

    countermeasureTargets[countermeasureTargetCount++] =
        {id, type, posX, altitude, posZ, ageSeconds};
    return true;
}

bool MissileSystem::deployCountermeasure(
    CountermeasureType type,
    float posX,
    float altitude,
    float posZ,
    float airspeedKnots,
    float heading,
    float pitch) {
    // Validate the flight pose before spending stores or reserving a decoy slot.
    if (!isValidCountermeasureType(type) ||
        !std::isfinite(posX) || !std::isfinite(altitude) || !std::isfinite(posZ) ||
        !std::isfinite(airspeedKnots) || !std::isfinite(heading) || !std::isfinite(pitch)) {
        return false;
    }
    if ((type == CountermeasureType::Chaff && (chaffRemaining <= 0 || chaffCooldown > 0.0f)) ||
        (type == CountermeasureType::Flare && (flaresRemaining <= 0 || flareCooldown > 0.0f))) {
        return false;
    }

    Countermeasure* available = nullptr;
    for (Countermeasure& candidate : countermeasures) {
        if (!candidate.present) {
            available = &candidate;
            break;
        }
    }
    if (!available) return false;

    Vector3 forward;
    Vector3 up;
    Vector3 right;
    get_orientation_basis(heading, pitch, 0.0f, forward, up, right);
    std::uint32_t id = nextCountermeasureId++;
    if (nextCountermeasureId == 0) nextCountermeasureId = 1;
    // Alternate small lateral offsets and eject aft so the decoy can separate from the aircraft.
    const float lateralOffset = id % 2 == 0 ? 18.0f : -18.0f;
    const float rearOffset = 260.0f;
    const float releaseSpeed = airspeedKnots * KTs_to_FPS -
        (type == CountermeasureType::Chaff ? 120.0f : 45.0f);
    const float verticalKick = type == CountermeasureType::Flare ? -8.0f : -2.0f;

    Countermeasure countermeasure;
    countermeasure.present = true;
    countermeasure.id = id;
    countermeasure.type = type;
    countermeasure.posX =
        posX - forward.x * rearOffset + right.x * lateralOffset - up.x * 8.0f;
    countermeasure.altitude =
        altitude - forward.y * rearOffset + right.y * lateralOffset - up.y * 8.0f;
    countermeasure.posZ =
        posZ - forward.z * rearOffset + right.z * lateralOffset - up.z * 8.0f;
    countermeasure.velocityX = forward.x * releaseSpeed + up.x * verticalKick;
    countermeasure.velocityY = forward.y * releaseSpeed + up.y * verticalKick;
    countermeasure.velocityZ = forward.z * releaseSpeed + up.z * verticalKick;
    *available = countermeasure;

    // The type-specific cooldown and finite inventory model separate dispensing from physics.
    if (type == CountermeasureType::Chaff) {
        --chaffRemaining;
        chaffCooldown = 0.35f;
    } else {
        --flaresRemaining;
        flareCooldown = 0.5f;
    }
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

int MissileSystem::getCountermeasureCount() const {
    return static_cast<int>(std::count_if(
        countermeasures.begin(),
        countermeasures.end(),
        [](const Countermeasure& countermeasure) { return countermeasure.present; }));
}

// The remaining accessors use the same compact live-decoy order as getCountermeasureCount().
std::uint32_t MissileSystem::getCountermeasureId(int index) const {
    if (index < 0) return 0;
    for (const Countermeasure& countermeasure : countermeasures) {
        if (!countermeasure.present) continue;
        if (index-- == 0) return countermeasure.id;
    }
    return 0;
}

std::uint32_t MissileSystem::getCountermeasureType(int index) const {
    if (index < 0) return static_cast<std::uint32_t>(CountermeasureType::Chaff);
    for (const Countermeasure& countermeasure : countermeasures) {
        if (!countermeasure.present) continue;
        if (index-- == 0) return static_cast<std::uint32_t>(countermeasure.type);
    }
    return static_cast<std::uint32_t>(CountermeasureType::Chaff);
}

float MissileSystem::getCountermeasurePosX(int index) const {
    if (index < 0) return 0.0f;
    for (const Countermeasure& countermeasure : countermeasures) {
        if (!countermeasure.present) continue;
        if (index-- == 0) return countermeasure.posX;
    }
    return 0.0f;
}

float MissileSystem::getCountermeasureAltitude(int index) const {
    if (index < 0) return 0.0f;
    for (const Countermeasure& countermeasure : countermeasures) {
        if (!countermeasure.present) continue;
        if (index-- == 0) return countermeasure.altitude;
    }
    return 0.0f;
}

float MissileSystem::getCountermeasurePosZ(int index) const {
    if (index < 0) return 0.0f;
    for (const Countermeasure& countermeasure : countermeasures) {
        if (!countermeasure.present) continue;
        if (index-- == 0) return countermeasure.posZ;
    }
    return 0.0f;
}

float MissileSystem::getCountermeasureAge(int index) const {
    if (index < 0) return 0.0f;
    for (const Countermeasure& countermeasure : countermeasures) {
        if (!countermeasure.present) continue;
        if (index-- == 0) return countermeasure.ageSeconds;
    }
    return 0.0f;
}
