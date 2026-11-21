#include "ws_gun.h"

#include <algorithm>
#include <cmath>

#include "utils.h"

namespace {
constexpr float gunshotMaxRangeFeet = FT_per_NM;
constexpr float gunshotHitRadiusFeet = 30.0f;
}

void Gun::ClearTargets()
{
    targetCount = 0;
}

bool Gun::AddTarget(
    std::uint32_t id,
    float posX,
    float altitude,
    float posZ) {
    if (id == 0 || targetCount >= maxTargets ||
        !std::isfinite(posX) || !std::isfinite(altitude) || !std::isfinite(posZ)) {
        return false;
    }
    targets[targetCount++] = {id, posX, altitude, posZ};
    return true;
}

std::uint32_t Gun::Shoot(
    float posX,
    float altitude,
    float posZ,
    float heading,
    float pitch) {
    if (ammo <= 0) return 0;
    --ammo;

    if (!std::isfinite(posX) || !std::isfinite(altitude) || !std::isfinite(posZ) ||
        !std::isfinite(heading) || !std::isfinite(pitch)) {
        return 0;
    }

    Vector3 forward;
    Vector3 up;
    Vector3 right;
    get_orientation_basis(heading, pitch, 0.0f, forward, up, right);

    std::uint32_t hitTargetId = 0;
    float nearestDistance = gunshotMaxRangeFeet;
    const float hitRadiusSquared = gunshotHitRadiusFeet * gunshotHitRadiusFeet;
    for (int index = 0; index < targetCount; ++index) {
        const Target& target = targets[index];
        const Vector3 toTarget{
            target.posX - posX,
            target.altitude - altitude,
            target.posZ - posZ,
        };
        const float alongRay =
            toTarget.x * forward.x + toTarget.y * forward.y + toTarget.z * forward.z;
        if (alongRay < 0.0f || alongRay > gunshotMaxRangeFeet + gunshotHitRadiusFeet) {
            continue;
        }

        const float hitDistance = std::min(alongRay, gunshotMaxRangeFeet);
        const float offsetX = toTarget.x - forward.x * hitDistance;
        const float offsetY = toTarget.y - forward.y * hitDistance;
        const float offsetZ = toTarget.z - forward.z * hitDistance;
        const float distanceSquared =
            offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ;
        if (distanceSquared <= hitRadiusSquared && hitDistance <= nearestDistance) {
            nearestDistance = hitDistance;
            hitTargetId = target.id;
        }
    }
    return hitTargetId;
}

int Gun::GetAmmo() const
{
    return ammo;
}

float Gun::GetFireRateRpm() const
{
    return fireRateRpm;
}

void Gun::SetAmmo(int newAmmo)
{
    ammo = newAmmo < 0 ? 0 : (newAmmo > 150 ? 150 : newAmmo);
}