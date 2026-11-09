#pragma once

#include <array>
#include <cstdint>

class Radar;
class Terrain;

struct MissileTypeConfig {
    std::uint32_t id;                       // Stable network/rendering type identifier.
    float maxRangeNm;                       // Maximum distance travelled before expiry.
    float maxSpeedKnots;                    // Terminal speed cap.
    float accelerationKnotsPerSecond;       // Constant simplified motor acceleration.
    float maxTurnRateDegreesPerSecond;      // Heading change cap independent of speed.
    float maxLateralG;                      // Additional speed-dependent turn limit.
    float lifetimeSeconds;                  // Self-destruct timer if no impact occurs.
    bool radarGuided;                       // Follows its launch-time radar track.
    bool triggersRwr;                       // Advertised to a targeted aircraft's RWR.
};

// Owns the local aircraft's missiles; snapshots are exposed to the UI/network layer.
class MissileSystem {
private:
    // Latest multiplayer aircraft positions are used for collision checks, even with radar off.
    struct AircraftTarget {
        std::uint32_t id = 0;                 // Same owner-local ID used by radar target mapping.
        float posX = 0.0f;                    // Current world position in simulator feet.
        float altitude = 0.0f;
        float posZ = 0.0f;
    };

    // A missile moves in world-space feet and keeps its target until it impacts or expires.
    struct Missile {
        bool present = false;                 // Slot is allocated, including during explosion FX.
        bool exploded = false;                // Flight has ended; retain briefly for replication.
        std::uint32_t id = 0;                 // Owner-local ID, paired with owner player ID.
        std::uint32_t typeId = 0;             // Selects the immutable missile type configuration.
        std::uint32_t targetId = 0;           // Radar target selected at launch, or zero.
        std::uint32_t impactTargetId = 0;     // Nonzero only when an aircraft was actually hit.
        float posX = 0.0f;                     // World position in simulator feet.
        float altitude = 0.0f;
        float posZ = 0.0f;
        float velocityX = 0.0f;                // World velocity in feet per second.
        float velocityY = 0.0f;
        float velocityZ = 0.0f;
        float distanceTravelled = 0.0f;        // Accumulated path length for maximum-range checks.
        float lifetimeRemaining = 0.0f;        // Flight-time fuse, independent of travelled range.
        float explosionTimeRemaining = 0.0f;   // Lifetime of the replicated explosion state.
    };

    // Bound storage and define shared physics units/impact windows.
    static constexpr int maxMissiles = 16;
    static constexpr int maxActiveMissiles = 8;
    static constexpr int maxAircraftTargets = 64;
    static constexpr float explosionDurationSeconds = 1.5f;
    static constexpr float impactRadiusFeet = 200.0f;

    std::array<Missile, maxMissiles> missiles{};
    std::array<AircraftTarget, maxAircraftTargets> aircraftTargets{};
    int aircraftTargetCount = 0;
    std::uint32_t nextMissileId = 1;

    // Type lookup rejects unsupported IDs instead of constructing a fallback weapon.
    static const MissileTypeConfig* getTypeConfig(std::uint32_t typeId);
    // Returns a compact active-missile index, skipping empty array slots.
    const Missile* getMissile(int index) const;
    // Enforces both the fixed slot capacity and active-flight limit.
    int findAvailableMissile() const;
    // Finds the closest aircraft within the configured impact radius.
    std::uint32_t findImpactTarget(float posX, float altitude, float posZ) const;
    // Stops guidance and starts the short explosion-reporting interval.
    void detonate(Missile& missile, std::uint32_t impactTargetId = 0);

public:
    // Selects the nearest radar track in range; returns 0=rejected, 1=unguided, 2=guided.
    int launch(
        std::uint32_t typeId,
        float posX,
        float altitude,
        float posZ,
        float airspeedKnots,
        float heading,
        float pitch,
        const Radar& radar);
    // Advances guidance, range/fuse checks, aircraft impacts, and explosion cleanup.
    void tick(float dt, const Terrain& terrain, const Radar& radar);
    // Replaces the collision list with fresh remote aircraft positions for the next tick.
    void clearAircraftTargets();
    // Adds a finite aircraft position to the bounded collision list.
    bool addAircraftTarget(std::uint32_t id, float posX, float altitude, float posZ);

    // Active/exploding missile snapshots, indexed in compact order for Embind.
    int getCount() const;
    std::uint32_t getId(int index) const;
    std::uint32_t getTypeId(int index) const;
    std::uint32_t getTargetId(int index) const;
    float getPosX(int index) const;
    float getAltitude(int index) const;
    float getPosZ(int index) const;
    float getHeading(int index) const;
    float getPitch(int index) const;
    bool getExploded(int index) const;
    std::uint32_t getImpactTargetId(int index) const;
    bool getTriggersRwr(int index) const;
};
