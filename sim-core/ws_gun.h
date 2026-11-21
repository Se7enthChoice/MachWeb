#pragma once

#include <array>
#include <cstdint>

class Gun 
{
private:
    struct Target {
        std::uint32_t id = 0;
        float posX = 0.0f;
        float altitude = 0.0f;
        float posZ = 0.0f;
    };

    static constexpr int maxTargets = 64;
    static constexpr float fireRateRpm = 600.0f;
    std::array<Target, maxTargets> targets{};
    int targetCount = 0;
    int ammo = 150;

public:
    void ClearTargets();
    bool AddTarget(std::uint32_t id, float posX, float altitude, float posZ);
    std::uint32_t Shoot(
        float posX,
        float altitude,
        float posZ,
        float heading,
        float pitch);

    int GetAmmo() const;
    float GetFireRateRpm() const;

    void SetAmmo(int newAmmo);
};