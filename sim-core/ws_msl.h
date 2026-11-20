#pragma once

#include <array>
#include <cstdint>

class Radar;
class Terrain;

enum class MissileSeeker : std::uint8_t {
    Radar,
    Infrared,
};

// Numeric values are shared with the WebAssembly and multiplayer telemetry APIs.
enum class CountermeasureType : std::uint32_t {
    Chaff = 1,
    Flare = 2,
};

struct MissileTypeConfig {
    std::uint32_t id;                       // Stable network/rendering type identifier.
    float maxRangeNm;                       // Maximum distance travelled before expiry.
    float maxSpeedKnots;                    // Terminal speed cap.
    float accelerationKnotsPerSecond;       // Constant simplified motor acceleration.
    float maxTurnRateDegreesPerSecond;      // Heading change cap independent of speed.
    float maxLateralG;                      // Additional speed-dependent turn limit.
    float lifetimeSeconds;                  // Self-destruct timer if no impact occurs.
    MissileSeeker seeker;                   // Sensor type determines compatible decoys.
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

    // Locally deployed decoys retain velocity and age for physics, guidance, and snapshots.
    struct Countermeasure {
        bool present = false;                // Slot is live until burn-out or ground contact.
        std::uint32_t id = 0;                // Owner-local ID paired with the player's network ID.
        CountermeasureType type = CountermeasureType::Chaff; // Determines seeker compatibility.
        float posX = 0.0f;                   // World-space position in simulator feet.
        float altitude = 0.0f;
        float posZ = 0.0f;
        float velocityX = 0.0f;              // Inherited release velocity, in feet per second.
        float velocityY = 0.0f;
        float velocityZ = 0.0f;
        float ageSeconds = 0.0f;             // Drives lifetime and seeker-signature decay.
    };

    // Remote decoys are refreshed from peer telemetry rather than simulated locally.
    struct CountermeasureTarget {
        std::uint32_t id = 0;                // Owner-local decoy ID; owner is carried by telemetry.
        CountermeasureType type = CountermeasureType::Chaff;
        float posX = 0.0f;
        float altitude = 0.0f;
        float posZ = 0.0f;
        float ageSeconds = 0.0f;             // Preserves signature decay across peer snapshots.
    };

    // Bound storage and define shared physics units/impact windows.
    static constexpr int maxMissiles = 16;
    static constexpr int maxActiveMissiles = 8;
    static constexpr int maxAircraftTargets = 64;
    static constexpr int maxCountermeasures = 32;       // Local decoys tracked for physics.
    static constexpr int maxCountermeasureTargets = 64; // Remote decoys available to seekers.
    static constexpr float explosionDurationSeconds = 1.5f;
    static constexpr float impactRadiusFeet = 200.0f;

    std::array<Missile, maxMissiles> missiles{};
    std::array<AircraftTarget, maxAircraftTargets> aircraftTargets{};
    std::array<Countermeasure, maxCountermeasures> countermeasures{};
    std::array<CountermeasureTarget, maxCountermeasureTargets> countermeasureTargets{};
    int aircraftTargetCount = 0;
    int countermeasureTargetCount = 0;       // Number of remote decoys loaded for the current tick.
    std::uint32_t nextMissileId = 1;
    std::uint32_t nextCountermeasureId = 1;
    int chaffRemaining = 24;                // Inventory is finite for the current flight.
    int flaresRemaining = 12;
    float chaffCooldown = 0.0f;             // Seconds until each dispenser can fire again.
    float flareCooldown = 0.0f;

    // Type lookup rejects unsupported IDs instead of constructing a fallback weapon.
    static const MissileTypeConfig* getTypeConfig(std::uint32_t typeId);
    // Returns a compact active-missile index, skipping empty array slots.
    const Missile* getMissile(int index) const;
    // Enforces both the fixed slot capacity and active-flight limit.
    int findAvailableMissile() const;
    // Finds the closest aircraft within the configured impact radius.
    std::uint32_t findImpactTarget(float posX, float altitude, float posZ) const;
    // Returns a target ID only for aircraft registered for physical hit impacts.
    std::uint32_t findImpactableAircraftTargetId(std::uint32_t targetId) const;
    // Stops guidance and starts the short explosion-reporting interval.
    void detonate(Missile& missile, std::uint32_t impactTargetId = 0);

public:
    // Returns 0=invalid, 1=unguided, 2=guided, 3=no slot, 4=stale track, 5=out of range.
    int launch(
        std::uint32_t typeId,
        std::uint32_t selectedTargetId,
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
    // Clears the remote-decoy list before loading each frame's fresh peer snapshots.
    void clearCountermeasureTargets();
    // Adds a validated remote decoy that can seduce only its compatible seeker type.
    bool addCountermeasureTarget(
        std::uint32_t id,
        CountermeasureType type,
        float posX,
        float altitude,
        float posZ,
        float ageSeconds);
    // Deploys one finite-stock decoy behind the aircraft, inheriting its current motion.
    bool deployCountermeasure(
        CountermeasureType type,
        float posX,
        float altitude,
        float posZ,
        float airspeedKnots,
        float heading,
        float pitch);

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
    // Compact snapshots expose only live local decoys; invalid indices return neutral values.
    int getCountermeasureCount() const;
    std::uint32_t getCountermeasureId(int index) const;
    std::uint32_t getCountermeasureType(int index) const;
    float getCountermeasurePosX(int index) const;
    float getCountermeasureAltitude(int index) const;
    float getCountermeasurePosZ(int index) const;
    float getCountermeasureAge(int index) const;
};
